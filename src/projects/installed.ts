/**
 * Builds the "Installed" and "Updates" views.
 *
 * Fast path: `dotnet list <target> package --format json` (one call per solution,
 * or per project when there is no solution), plus `--outdated` for update info.
 * Fallback (no SDK): read PackageReference/PackageVersion from the parsed project
 * model and query each feed's flat container for the latest version.
 */

import * as path from "path";
import { InstalledPackage } from "../panel/messaging";
import { DotnetCli, DotnetListOutput } from "../dotnet/cli";
import { ProjectRegistry, WorkspaceProject } from "./discovery";
import { FeedRegistry } from "../nuget/feeds";
import { MetadataService } from "../nuget/metadata";
import { maxVersion } from "../nuget/NuGetVersion";

export class InstalledService {
  constructor(
    private readonly projects: ProjectRegistry,
    private readonly dotnet: DotnetCli,
    private readonly feeds: FeedRegistry,
    private readonly metadata: MetadataService
  ) {}

  async list(includeTransitive: boolean): Promise<{ packages: InstalledPackage[]; sdkAvailable: boolean }> {
    const sdkAvailable = await this.dotnet.isAvailable();
    const merged = new Map<string, InstalledPackage>();

    if (sdkAvailable) {
      for (const target of this.resolveTargets()) {
        const flags = includeTransitive ? ["--include-transitive"] : [];
        const out = await this.dotnet.listPackages(target, flags);
        if (out) {
          this.foldDotnetOutput(out, merged, includeTransitive);
        }
      }
    }

    if (merged.size === 0) {
      // Fallback to the parsed project model.
      for (const project of this.projects.getProjects()) {
        this.foldProjectModel(project, merged);
      }
    }

    return { packages: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)), sdkAvailable };
  }

  /** Installed packages that have a newer version available. */
  async listUpdates(): Promise<InstalledPackage[]> {
    const sdkAvailable = await this.dotnet.isAvailable();
    const merged = new Map<string, InstalledPackage>();

    if (sdkAvailable) {
      for (const target of this.resolveTargets()) {
        const out = await this.dotnet.listPackages(target, ["--outdated"]);
        if (out) this.foldDotnetOutput(out, merged, false);
      }
      return [...merged.values()]
        .filter((p) => p.latestVersion && p.latestVersion !== p.requestedVersion)
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    // Fallback: compute latest ourselves.
    const base = await this.list(false);
    const includePrerelease = false;
    await Promise.all(
      base.packages.map(async (pkg) => {
        pkg.latestVersion = await this.latestAcrossFeeds(pkg.id, includePrerelease);
      })
    );
    return base.packages
      .filter((p) => p.latestVersion && p.latestVersion !== p.requestedVersion)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  private resolveTargets(): string[] {
    const projects = this.projects.getProjects();
    const solutions = new Set<string>();
    const looseProjects: string[] = [];
    for (const p of projects) {
      if (p.info.solution) solutions.add(p.info.solution);
      else looseProjects.push(p.info.path);
    }
    return [...solutions, ...looseProjects];
  }

  private foldDotnetOutput(
    out: DotnetListOutput,
    merged: Map<string, InstalledPackage>,
    includeTransitive: boolean
  ): void {
    for (const project of out.projects ?? []) {
      // `dotnet list --format json` emits forward-slash paths; the project
      // registry (and thus the webview's ProjectInfo.path) uses OS-native paths.
      // Canonicalise so per-project lookups in the details view line up.
      const projectPath = this.projects.findByPath(project.path)?.info.path ?? path.normalize(project.path);
      for (const fw of project.frameworks ?? []) {
        const groups: [boolean, typeof fw.topLevelPackages][] = [
          [false, fw.topLevelPackages ?? []]
        ];
        if (includeTransitive) groups.push([true, fw.transitivePackages ?? []]);

        for (const [transitive, list] of groups) {
          for (const pkg of list ?? []) {
            const key = pkg.id.toLowerCase();
            const existing = merged.get(key);
            const entry: InstalledPackage = existing ?? {
              id: pkg.id,
              requestedVersion: pkg.requestedVersion ?? pkg.resolvedVersion ?? "",
              resolvedVersion: pkg.resolvedVersion,
              projects: [],
              projectVersions: [],
              transitive
            };
            if (!existing) merged.set(key, entry);
            entry.transitive = entry.transitive && transitive;
            if (pkg.requestedVersion && !entry.requestedVersion) entry.requestedVersion = pkg.requestedVersion;
            if (pkg.resolvedVersion) entry.resolvedVersion = pkg.resolvedVersion;
            if (pkg.latestVersion) entry.latestVersion = pkg.latestVersion;
            if (pkg.deprecationReasons?.length) entry.deprecated = true;
            if (pkg.vulnerabilities?.length) entry.hasVulnerability = true;
            if (!entry.projects.includes(projectPath)) entry.projects.push(projectPath);
            if (!transitive) {
              const v = pkg.requestedVersion ?? pkg.resolvedVersion ?? "";
              if (v && !entry.projectVersions.some((pv) => pv.project === projectPath)) {
                entry.projectVersions.push({ project: projectPath, version: v });
              }
            }
          }
        }
      }
    }
  }

  private foldProjectModel(project: WorkspaceProject, merged: Map<string, InstalledPackage>): void {
    for (const ref of project.parsed.packageReferences) {
      const key = ref.id.toLowerCase();
      let version = ref.versionOverride || ref.version;
      if (!version && project.info.usesCentralPackageManagement) {
        version = project.cpm.versions.get(key)?.version ?? "";
      }
      const existing = merged.get(key);
      const entry: InstalledPackage = existing ?? {
        id: ref.id,
        requestedVersion: version,
        projects: [],
        projectVersions: [],
        transitive: false
      };
      if (!existing) merged.set(key, entry);
      if (version && !entry.requestedVersion) entry.requestedVersion = version;
      if (!entry.projects.includes(project.info.path)) entry.projects.push(project.info.path);
      if (version && !entry.projectVersions.some((pv) => pv.project === project.info.path)) {
        entry.projectVersions.push({ project: project.info.path, version });
      }
    }
  }

  private async latestAcrossFeeds(id: string, includePrerelease: boolean): Promise<string | undefined> {
    const all: string[] = [];
    for (const feed of this.feeds.getEnabledV3Feeds()) {
      try {
        const versions = await this.metadata.listVersions(feed.url, id);
        all.push(...versions);
      } catch {
        /* ignore feed errors */
      }
    }
    return maxVersion(all, includePrerelease);
  }
}

export function projectDisplayName(projectPath: string): string {
  return path.basename(projectPath, path.extname(projectPath));
}
