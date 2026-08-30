/**
 * Convert a set of classic projects to Central Package Management.
 *
 * The scope is the solution (or folder) the manager was opened from. A single
 * `Directory.Packages.props` is created (or an existing one enabled) in that
 * directory with a `<PackageVersion>` per package; each project's
 * `<PackageReference>` versions are stripped to bare references. When the same
 * package is referenced at different versions the highest one wins and the bumps
 * are reported.
 * https://learn.microsoft.com/nuget/consume-packages/central-package-management
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { CpmConversionPlan, CpmConversionResult } from "../panel/messaging";
import { DotnetCli } from "../dotnet/cli";
import { ProjectRegistry, WorkspaceProject } from "./discovery";
import {
  buildPropsFile,
  commonAncestor,
  mergeExistingVersions,
  parsePackageVersionItems,
  resolveCentralVersions
} from "./cpmPlan";
import {
  removeCentralManagementOptOut,
  setManagePackageVersionsCentrally,
  stripVersionAttributes,
  upsertPackageVersion
} from "./xmlEdit";

export class CpmConversionService {
  constructor(
    private readonly projects: ProjectRegistry,
    private readonly dotnet: DotnetCli,
    private readonly output: vscode.OutputChannel
  ) {}

  /**
   * Convert `projectPaths` (classic projects) to CPM. `confirm` is called with the
   * plan before anything is written; returning `false` aborts.
   */
  async convert(
    projectPaths: string[],
    confirm: (plan: CpmConversionPlan) => Promise<boolean>
  ): Promise<CpmConversionResult> {
    const empty: CpmConversionResult = {
      ok: false,
      projectCount: 0,
      packageCount: 0,
      bumps: [],
      warnings: [],
      restoreNeeded: false
    };

    const scoped = projectPaths
      .map((p) => this.projects.findByPath(p))
      .filter((p): p is WorkspaceProject => !!p && !p.info.usesCentralPackageManagement);

    if (scoped.length === 0) {
      return { ...empty, message: "No classic projects to convert in this scope." };
    }

    const { warnings, propsPath, propsDir, propsExists } = resolvePropsLocation(scoped);

    // A `Directory.Packages.props` governs every project beneath it, so every
    // classic project under `propsDir` must be converted too — otherwise its
    // inline `Version=` attributes clash with central management (NU1008).
    const targets = this.projects
      .getProjects()
      .filter(
        (p) =>
          !p.info.usesCentralPackageManagement &&
          isUnder(path.dirname(path.resolve(p.info.path)), propsDir)
      );
    for (const s of scoped) {
      if (!targets.includes(s)) targets.push(s);
    }
    const extra = targets.length - scoped.length;
    if (extra > 0) {
      warnings.push(
        `${extra} more classic project(s) under ${path.basename(propsDir)} were included so they stay buildable under the shared props file.`
      );
    }

    const withRefs = targets.filter((t) => t.parsed.packageReferences.some((r) => refVersion(r)));
    if (withRefs.length === 0 && !propsExists) {
      return { ...empty, message: "The selected projects have no versioned package references." };
    }

    const resolved = resolveCentralVersions(
      withRefs.map((t) => ({
        path: t.info.path,
        name: t.info.name,
        refs: t.parsed.packageReferences
          .map((r) => ({ id: r.id, version: refVersion(r) }))
          .filter((r) => r.version)
      }))
    );
    const bumps = resolved.bumps;
    const versions = propsExists
      ? mergeExistingVersions(resolved.versions, parsePackageVersionItems(fs.readFileSync(propsPath, "utf8")))
      : resolved.versions;

    const plan: CpmConversionPlan = {
      propsPath,
      propsExists,
      relativePropsPath: vscode.workspace.asRelativePath(propsPath),
      targets: targets.map((t) => ({ path: t.info.path, name: t.info.name })),
      versions,
      bumps,
      warnings
    };

    if (!(await confirm(plan))) {
      return { ...empty, cancelled: true };
    }

    try {
      this.writePropsFile(propsPath, propsExists, versions);
      for (const target of targets) {
        this.rewriteProject(target);
      }
    } catch (err: any) {
      return { ...empty, warnings, message: err?.message ?? String(err) };
    }

    let restoreNeeded = false;
    const sdk = await this.dotnet.isAvailable();
    if (sdk && vscode.workspace.getConfiguration("nuget").get<boolean>("autoRestore", true)) {
      const r = await this.dotnet.restore();
      restoreNeeded = r.code !== 0;
    } else if (!sdk) {
      restoreNeeded = true;
    }

    if (bumps.length > 0) {
      this.output.appendLine(
        `[cpm] converted ${targets.length} project(s); ${bumps.length} reference(s) bumped:`
      );
      for (const b of bumps) {
        this.output.appendLine(`[cpm]   ${b.project}: ${b.packageId} ${b.from} -> ${b.to}`);
      }
    }

    await this.projects.refresh();

    return {
      ok: true,
      propsPath,
      projectCount: targets.length,
      packageCount: versions.length,
      bumps,
      warnings,
      restoreNeeded
    };
  }

  private writePropsFile(
    propsPath: string,
    exists: boolean,
    versions: { id: string; version: string }[]
  ): void {
    if (exists) {
      let text = fs.readFileSync(propsPath, "utf8");
      text = setManagePackageVersionsCentrally(text, true);
      for (const v of versions) text = upsertPackageVersion(text, v.id, v.version);
      fs.writeFileSync(propsPath, text, "utf8");
      return;
    }
    fs.mkdirSync(path.dirname(propsPath), { recursive: true });
    fs.writeFileSync(propsPath, buildPropsFile(versions), "utf8");
  }

  private rewriteProject(project: WorkspaceProject): void {
    const original = fs.readFileSync(project.info.path, "utf8");
    let text = original;
    if (project.parsed.managePackageVersionsCentrally === false) {
      text = removeCentralManagementOptOut(text);
    }
    for (const ref of project.parsed.packageReferences) {
      if (refVersion(ref)) text = stripVersionAttributes(text, ref.id);
    }
    if (text !== original) fs.writeFileSync(project.info.path, text, "utf8");
  }
}

function refVersion(ref: { version: string; versionOverride?: string }): string {
  return (ref.versionOverride || ref.version || "").trim();
}

function resolvePropsLocation(targets: WorkspaceProject[]): {
  propsPath: string;
  propsDir: string;
  propsExists: boolean;
  warnings: string[];
} {
  const warnings: string[] = [];
  const done = (dir: string): { propsPath: string; propsDir: string; propsExists: boolean; warnings: string[] } => {
    const propsPath = path.join(dir, "Directory.Packages.props");
    return { propsPath, propsDir: dir, propsExists: fs.existsSync(propsPath), warnings };
  };

  // 1. Reuse an existing props file when the whole scope already shares one.
  const existing = [...new Set(targets.map((t) => t.cpm.propsPath).filter((p): p is string => !!p))];
  if (existing.length === 1) {
    return done(path.dirname(existing[0]));
  }
  if (existing.length > 1) {
    warnings.push(
      "Projects sit under different Directory.Packages.props files; a new one was placed at the common directory."
    );
  }

  // 2. A single solution that covers every target -> next to the .sln.
  const solutions = [...new Set(targets.map((t) => t.info.solution).filter((s): s is string => !!s))];
  if (solutions.length === 1 && targets.every((t) => t.info.solution === solutions[0])) {
    return done(path.dirname(solutions[0]));
  }
  if (solutions.length > 1) {
    warnings.push(
      "Projects span multiple solutions; Directory.Packages.props was placed at their common directory."
    );
  }

  // 3. Common ancestor directory, clamped to the workspace root.
  const dirs = targets.map((t) => path.dirname(path.resolve(t.info.path)));
  const root = path.resolve(targets[0].workspaceRoot);
  let dir = commonAncestor(dirs, path.sep);
  if (!dir || !isUnder(dir, root)) dir = root;
  return done(dir);
}

/** Is `child` the same as, or nested inside, `parent`? */
function isUnder(child: string, parent: string): boolean {
  const c = path.resolve(child).toLowerCase();
  const p = path.resolve(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}
