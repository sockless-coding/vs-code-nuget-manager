/**
 * Builds the "Installed" and "Updates" views.
 *
 * Fast path: `dotnet list <target> package --format json` (one call per solution,
 * or per project when there is no solution), plus `--outdated` for update info and
 * `--vulnerable --include-transitive` for advisories. Fallback (no SDK): read
 * PackageReference/PackageVersion from the parsed project model and query each
 * feed's flat container for the latest version.
 *
 * Regardless of path, `obj/project.assets.json` is read for the resolved
 * dependency graph (who pulls in each transitive package) and for audit
 * warnings, so a vulnerable transitive package always surfaces.
 */

import * as path from "path";
import { InstalledPackage } from "../panel/messaging";
import { DotnetCli, DotnetListOutput, DotnetListPackage } from "../dotnet/cli";
import { ProjectRegistry, WorkspaceProject } from "./discovery";
import { FeedRegistry } from "../nuget/feeds";
import { MetadataService } from "../nuget/metadata";
import { maxVersion } from "../nuget/NuGetVersion";
import { Advisory, DependencyGraph, mergeGraphs, readAssetsGraph } from "./assetsGraph";
import { mapWithConcurrency } from "../util";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_WORDS: Record<string, number> = {
  low: 0,
  moderate: 1,
  medium: 1,
  high: 2,
  critical: 3
};

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
        // Always scan for advisories, transitive included, no matter the toggle.
        const vuln = await this.dotnet.listPackages(target, ["--vulnerable", "--include-transitive"]);
        if (vuln) this.foldVulnerable(vuln, merged);
      }
    }

    if (merged.size === 0) {
      // Fallback to the parsed project model.
      for (const project of this.projects.getProjects()) {
        this.foldProjectModel(project, merged);
      }
    }

    this.applyGraph(merged);
    await this.applyIcons(merged.values());

    return { packages: [...merged.values()].sort((a, b) => a.id.localeCompare(b.id)), sdkAvailable };
  }

  /** Installed packages that have a newer version available. */
  async listUpdates(minimumPackageAgeDays = 0): Promise<InstalledPackage[]> {
    const sdkAvailable = await this.dotnet.isAvailable();
    const merged = new Map<string, InstalledPackage>();
    let updates: InstalledPackage[];

    if (sdkAvailable) {
      for (const target of this.resolveTargets()) {
        const out = await this.dotnet.listPackages(target, ["--outdated"]);
        if (out) this.foldDotnetOutput(out, merged, false);
      }
      updates = [...merged.values()]
        .filter((p) => p.latestVersion && p.latestVersion !== p.requestedVersion)
        .sort((a, b) => a.id.localeCompare(b.id));
      await this.applyIcons(updates);
    } else {
      // Fallback: compute latest ourselves.
      const base = await this.list(false);
      await Promise.all(
        base.packages.map(async (pkg) => {
          pkg.latestVersion = await this.latestAcrossFeeds(pkg.id, false);
        })
      );
      updates = base.packages
        .filter((p) => p.latestVersion && p.latestVersion !== p.requestedVersion)
        .sort((a, b) => a.id.localeCompare(b.id));
    }

    await this.applyLatestPublished(updates, minimumPackageAgeDays);
    return updates;
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
            if (pkg.vulnerabilities?.length) this.applyAdvisories(entry, toAdvisories(pkg.vulnerabilities));
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

  /** Fold the `--vulnerable` pass: adds transitive entries even when the toggle is off. */
  private foldVulnerable(out: DotnetListOutput, merged: Map<string, InstalledPackage>): void {
    for (const project of out.projects ?? []) {
      const projectPath = this.projects.findByPath(project.path)?.info.path ?? path.normalize(project.path);
      for (const fw of project.frameworks ?? []) {
        const groups: [boolean, DotnetListPackage[] | undefined][] = [
          [false, fw.topLevelPackages],
          [true, fw.transitivePackages]
        ];
        for (const [transitive, list] of groups) {
          for (const pkg of list ?? []) {
            if (!pkg.vulnerabilities?.length) continue;
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
            else entry.transitive = entry.transitive && transitive;
            if (pkg.resolvedVersion) entry.resolvedVersion = pkg.resolvedVersion;
            if (!entry.projects.includes(projectPath)) entry.projects.push(projectPath);
            this.applyAdvisories(entry, toAdvisories(pkg.vulnerabilities));
            this.markVulnerableProject(entry, projectPath);
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

  /** Attach `requiredBy` / `dependsOn` and graph-sourced advisories. */
  private applyGraph(merged: Map<string, InstalledPackage>): void {
    const perProject = this.projects.getProjects().map((p) => ({
      path: p.info.path,
      graph: readAssetsGraph(path.dirname(p.info.path))
    }));
    const graph = mergeGraphs(perProject.map((p) => p.graph));

    // Surface vulnerable transitive packages the CLI pass may have missed.
    for (const [key, advisories] of graph.vulnerabilities) {
      if (merged.has(key) || advisories.length === 0) continue;
      merged.set(key, {
        id: graph.displayName.get(key) ?? key,
        requestedVersion: "",
        projects: [],
        projectVersions: [],
        transitive: true
      });
    }

    for (const entry of merged.values()) {
      const key = entry.id.toLowerCase();
      applyGraphEdges(entry, key, graph);
      const advisories = graph.vulnerabilities.get(key);
      if (advisories?.length) this.applyAdvisories(entry, advisories);
      // Per-project attribution so the details pane can point at the offender.
      for (const { path: projectPath, graph: g } of perProject) {
        if (g?.vulnerabilities.get(key)?.length) {
          this.markVulnerableProject(entry, projectPath);
          if (!entry.projects.includes(projectPath)) entry.projects.push(projectPath);
        }
      }
    }
  }

  private markVulnerableProject(entry: InstalledPackage, projectPath: string): void {
    if (!projectPath) return;
    entry.vulnerableProjects ??= [];
    if (!entry.vulnerableProjects.includes(projectPath)) entry.vulnerableProjects.push(projectPath);
  }

  private async applyIcons(packages: Iterable<InstalledPackage>): Promise<void> {
    const base = await this.firstFlatContainerBase();
    if (!base) return;
    for (const entry of packages) {
      const raw = entry.resolvedVersion || entry.requestedVersion || "";
      const version = raw.replace(/[[\]()]/g, "").split(",")[0].trim();
      if (version && /^\d/.test(version)) {
        entry.iconUrl = `${base}/${entry.id.toLowerCase()}/${version.toLowerCase()}/icon`;
      }
    }
  }

  private async applyLatestPublished(packages: InstalledPackage[], minAgeDays: number): Promise<void> {
    const feeds = this.feeds.getEnabledV3Feeds();
    if (feeds.length === 0) return;
    await mapWithConcurrency(packages, 8, async (pkg) => {
      if (!pkg.latestVersion) return;
      for (const feed of feeds) {
        try {
          const dates = await this.metadata.publishedDates(feed.url, pkg.id);
          const d = dates.get(pkg.latestVersion.toLowerCase());
          if (d) {
            pkg.latestPublished = d;
            break;
          }
        } catch {
          /* ignore feed errors */
        }
      }
      if (pkg.latestPublished && minAgeDays > 0) {
        const ageDays = (Date.now() - Date.parse(pkg.latestPublished)) / DAY_MS;
        pkg.latestBelowMinAge = Number.isFinite(ageDays) && ageDays < minAgeDays;
      }
    });
  }

  private applyAdvisories(entry: InstalledPackage, advisories: Advisory[]): void {
    if (advisories.length === 0) return;
    const list = entry.vulnerabilities ?? [];
    for (const a of advisories) {
      if (!list.some((x) => x.advisoryUrl === a.advisoryUrl && x.severity === a.severity)) {
        list.push(a);
      }
    }
    entry.vulnerabilities = list;
    entry.hasVulnerability = true;
    entry.maxVulnerabilitySeverity = list.reduce((m, a) => Math.max(m, a.severity), -1);
  }

  private async firstFlatContainerBase(): Promise<string | undefined> {
    for (const feed of this.feeds.getEnabledV3Feeds()) {
      try {
        const base = await this.metadata.flatContainerBase(feed.url);
        if (base) return base;
      } catch {
        /* ignore */
      }
    }
    return undefined;
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

function applyGraphEdges(entry: InstalledPackage, key: string, graph: DependencyGraph): void {
  const requiredBy = graph.dependents.get(key);
  if (requiredBy?.size) {
    entry.requiredBy = [...requiredBy].map((k) => graph.displayName.get(k) ?? k).sort((a, b) => a.localeCompare(b));
  }
  const dependsOn = graph.dependencies.get(key);
  if (dependsOn?.size) {
    entry.dependsOn = [...dependsOn].map((k) => graph.displayName.get(k) ?? k).sort((a, b) => a.localeCompare(b));
  }
}

function toAdvisories(raw: { severity: string; advisoryurl: string }[]): Advisory[] {
  return raw.map((v) => ({
    severity: SEVERITY_WORDS[String(v.severity).toLowerCase()] ?? 0,
    advisoryUrl: v.advisoryurl
  }));
}

export function projectDisplayName(projectPath: string): string {
  return path.basename(projectPath, path.extname(projectPath));
}
