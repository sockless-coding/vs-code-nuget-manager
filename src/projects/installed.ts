/**
 * Builds the "Installed" view and its update / vulnerability enrichment.
 *
 * The list is produced in two phases so a large solution paints immediately:
 *
 *  1. A local snapshot, read entirely from disk with no `dotnet` invocation:
 *     `PackageReference` / `PackageVersion` from the parsed project + CPM model for
 *     requested versions, and every project's `obj/project.assets.json` for the
 *     resolved dependency graph, resolved versions, transitive classification and
 *     NuGet audit warnings (offline vulnerabilities).
 *
 *  2. Background enrichment: the latest available version and publish date for each
 *     direct package (feed flat-container queries, concurrency-limited), plus an
 *     online advisory top-up. Progress and partial results are streamed to the
 *     webview through the {@link InstalledNotifier}.
 *
 * Setting `nuget.useDotnetListForEnumeration` additionally reconciles the snapshot
 * with `dotnet list package --outdated` / `--vulnerable` (run in parallel, with
 * `--no-restore`) during enrichment, for projects that need `dotnet`'s exact
 * resolution semantics.
 */

import * as path from "path";
import * as vscode from "vscode";
import { InstalledPackage } from "../panel/messaging";
import { DotnetCli, DotnetListOutput, DotnetListPackage } from "../dotnet/cli";
import { ProjectRegistry, WorkspaceProject } from "./discovery";
import { FeedRegistry } from "../nuget/feeds";
import { MetadataService } from "../nuget/metadata";
import { maxVersion } from "../nuget/NuGetVersion";
import { isExactVersionPin, stripVersionPin } from "../nuget/versionRange";
import { Advisory, DependencyGraph, mergeGraphs, readAssetsGraphAsync } from "./assetsGraph";
import { mapWithConcurrency } from "../util";

const DAY_MS = 24 * 60 * 60 * 1000;
const SEVERITY_WORDS: Record<string, number> = {
  low: 0,
  moderate: 1,
  medium: 1,
  high: 2,
  critical: 3
};

/** How the extension host is told about streamed enrichment progress and results. */
export interface InstalledNotifier {
  /** A short status line for the webview banner. `done` clears it. */
  progress(message: string, done: boolean): void;
  /** A fresh copy of the installed list, filtered for the current view. */
  enriched(phase: "updates" | "vulnerabilities" | "done", packages: InstalledPackage[]): void;
}

export class InstalledService {
  /** The full unfiltered snapshot (direct + transitive), shared by every consumer. */
  private snapshot: InstalledPackage[] | undefined;
  private snapshotPromise: Promise<InstalledPackage[]> | undefined;
  /** Bumped whenever the on-disk model changes; stale async work checks against it. */
  private runToken = 0;
  private enrichPromise: Promise<void> | undefined;
  private enrichToken = -1;
  /** The `includeTransitive` value of the last `list()` call, for enriched pushes. */
  private lastIncludeTransitive = false;

  constructor(
    private readonly projects: ProjectRegistry,
    private readonly dotnet: DotnetCli,
    private readonly feeds: FeedRegistry,
    private readonly metadata: MetadataService,
    private readonly notify: InstalledNotifier
  ) {}

  /** Drop cached results; the next `list()` rebuilds from disk. */
  invalidate(): void {
    this.runToken++;
    this.snapshot = undefined;
    this.snapshotPromise = undefined;
    this.enrichPromise = undefined;
  }

  async list(includeTransitive: boolean): Promise<{ packages: InstalledPackage[]; sdkAvailable: boolean }> {
    this.lastIncludeTransitive = includeTransitive;
    const snap = await this.ensureSnapshot();
    void this.ensureEnrichment();
    return {
      packages: this.filterForView(snap, includeTransitive),
      sdkAvailable: await this.dotnet.isAvailable()
    };
  }

  /* --------------------------- phase 1: snapshot --------------------------- */

  private ensureSnapshot(): Promise<InstalledPackage[]> {
    if (this.snapshot) return Promise.resolve(this.snapshot);
    if (!this.snapshotPromise) {
      const token = this.runToken;
      this.snapshotPromise = this.buildLocalSnapshot().then((snap) => {
        if (token === this.runToken) this.snapshot = snap;
        this.snapshotPromise = undefined;
        return this.snapshot ?? snap;
      });
    }
    return this.snapshotPromise;
  }

  private async buildLocalSnapshot(): Promise<InstalledPackage[]> {
    const projects = this.projects.getProjects();
    const merged = new Map<string, InstalledPackage>();

    // Requested versions + per-project direct references from the parsed model.
    for (const project of projects) this.foldProjectModel(project, merged);

    // Resolved dependency graph — one assets file per project, read in parallel.
    const graphs = await mapWithConcurrency(projects, 12, (p) =>
      readAssetsGraphAsync(path.dirname(p.info.path))
    );
    const perProject = projects.map((p, i) => ({ path: p.info.path, graph: graphs[i] }));
    const graph = mergeGraphs(graphs);

    // Add packages that appear only in the resolved graph (transitive, or vulnerable
    // transitive the audit logs flagged).
    for (const [key, display] of graph.displayName) {
      if (merged.has(key)) continue;
      if (!graph.resolved.has(key) && !graph.vulnerabilities.get(key)?.length) continue;
      merged.set(key, {
        id: display,
        requestedVersion: "",
        projects: [],
        projectVersions: [],
        transitive: true
      });
    }

    for (const [key, entry] of merged) {
      if (graph.topLevel.has(key)) entry.transitive = false;
      else if (entry.projectVersions.length === 0) entry.transitive = true;

      const resolved = graph.resolved.get(key);
      if (resolved) entry.resolvedVersion = resolved;

      applyGraphEdges(entry, key, graph);

      const advisories = graph.vulnerabilities.get(key);
      if (advisories?.length) this.applyAdvisories(entry, advisories);
      for (const { path: projectPath, graph: g } of perProject) {
        if (g?.vulnerabilities.get(key)?.length) {
          this.markVulnerableProject(entry, projectPath);
          if (!entry.projects.includes(projectPath)) entry.projects.push(projectPath);
        }
      }
    }

    this.markPinned(merged);
    await this.applyIcons(merged.values());

    return [...merged.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  private filterForView(snapshot: InstalledPackage[], includeTransitive: boolean): InstalledPackage[] {
    return snapshot
      .filter((p) => includeTransitive || !p.transitive || p.hasVulnerability)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  /* -------------------------- phase 2: enrichment ------------------------- */

  private ensureEnrichment(): Promise<void> {
    if (this.enrichPromise && this.enrichToken === this.runToken) return this.enrichPromise;
    const token = this.runToken;
    this.enrichToken = token;
    this.enrichPromise = this.runEnrichment(token)
      .catch(() => {
        /* enrichment is best-effort */
      })
      .finally(() => {
        if (this.enrichToken === token) this.notify.progress("", true);
      });
    return this.enrichPromise;
  }

  private async runEnrichment(token: number): Promise<void> {
    const snap = await this.ensureSnapshot();
    if (token !== this.runToken) return;

    const feeds = this.feeds.getEnabledV3Feeds();
    const direct = snap.filter((p) => !p.transitive);
    const includePrerelease = vscode.workspace
      .getConfiguration("nuget")
      .get<boolean>("defaultIncludePrerelease", false);

    if (feeds.length > 0 && direct.length > 0) {
      const total = direct.length;
      let done = 0;
      let lastPush = 0;
      this.notify.progress(`Checking ${total} package${total === 1 ? "" : "s"} for updates…`, false);
      await mapWithConcurrency(direct, 12, async (pkg) => {
        if (token !== this.runToken) return;
        const latest = await this.latestAcrossFeeds(pkg.id, includePrerelease);
        if (latest) pkg.latestVersion = latest;
        done++;
        this.notify.progress(`Checking ${total} packages for updates… (${done}/${total})`, false);
        if (Date.now() - lastPush > 400) {
          lastPush = Date.now();
          this.pushEnriched("updates");
        }
      });
      if (token !== this.runToken) return;
      this.pushEnriched("updates");

      const outdated = direct.filter(
        (p) => p.latestVersion && p.latestVersion !== stripVersionPin(p.requestedVersion)
      );
      if (outdated.length > 0) {
        this.notify.progress("Checking release dates…", false);
        await this.applyLatestPublished(outdated, this.minimumPackageAgeDays());
        if (token !== this.runToken) return;
        this.pushEnriched("updates");
      }

      this.notify.progress("Checking for known vulnerabilities…", false);
      await mapWithConcurrency(direct, 8, async (pkg) => {
        if (token !== this.runToken) return;
        const version = cleanVersion(pkg.resolvedVersion || pkg.requestedVersion || "");
        if (!version) return;
        for (const feed of feeds) {
          try {
            const advisories = await this.metadata.vulnerabilitiesFor(feed.url, pkg.id, version);
            if (advisories.length) this.applyAdvisories(pkg, advisories);
            // The advisory database is global; the first reachable feed answers for all.
            break;
          } catch {
            /* try the next feed */
          }
        }
      });
      if (token !== this.runToken) return;
      this.pushEnriched("vulnerabilities");
    }

    if (this.useDotnetListForEnumeration() && (await this.dotnet.isAvailable())) {
      await this.reconcileWithDotnet(snap, token);
      if (token !== this.runToken) return;
    }

    this.pushEnriched("done");
  }

  private pushEnriched(phase: "updates" | "vulnerabilities" | "done"): void {
    if (!this.snapshot) return;
    this.notify.enriched(phase, this.filterForView(this.snapshot, this.lastIncludeTransitive));
  }

  /** Opt-in: fold `dotnet list --outdated` / `--vulnerable` over the snapshot. */
  private async reconcileWithDotnet(snap: InstalledPackage[], token: number): Promise<void> {
    const byId = new Map(snap.map((p) => [p.id.toLowerCase(), p]));
    this.notify.progress("Reconciling with dotnet…", false);
    const passes = this.resolveTargets().flatMap((target) => [
      this.dotnet.listPackages(target, ["--outdated", "--no-restore"]),
      this.dotnet.listPackages(target, ["--vulnerable", "--include-transitive", "--no-restore"])
    ]);
    const results = await Promise.all(passes);
    if (token !== this.runToken) return;
    for (let i = 0; i < results.length; i++) {
      const out = results[i];
      if (!out) continue;
      if (i % 2 === 0) this.foldOutdated(out, byId);
      else this.foldVulnerable(out, byId);
    }
  }

  /* ------------------------------ folding -------------------------------- */

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
      entry.transitive = false;
      if (version && !entry.requestedVersion) entry.requestedVersion = version;
      if (!entry.projects.includes(project.info.path)) entry.projects.push(project.info.path);
      if (version && !entry.projectVersions.some((pv) => pv.project === project.info.path)) {
        entry.projectVersions.push({ project: project.info.path, version });
      }
    }
  }

  /** Fold a `--outdated` pass: only `latestVersion` / `deprecated` are of interest. */
  private foldOutdated(out: DotnetListOutput, byId: Map<string, InstalledPackage>): void {
    for (const project of out.projects ?? []) {
      for (const fw of project.frameworks ?? []) {
        for (const pkg of fw.topLevelPackages ?? []) {
          const entry = byId.get(pkg.id.toLowerCase());
          if (!entry) continue;
          if (pkg.latestVersion) entry.latestVersion = pkg.latestVersion;
          if (pkg.deprecationReasons?.length) entry.deprecated = true;
        }
      }
    }
  }

  private foldVulnerable(out: DotnetListOutput, byId: Map<string, InstalledPackage>): void {
    for (const project of out.projects ?? []) {
      const projectPath = this.projects.findByPath(project.path)?.info.path ?? path.normalize(project.path);
      for (const fw of project.frameworks ?? []) {
        const groups: (DotnetListPackage[] | undefined)[] = [fw.topLevelPackages, fw.transitivePackages];
        for (const list of groups) {
          for (const pkg of list ?? []) {
            if (!pkg.vulnerabilities?.length) continue;
            const entry = byId.get(pkg.id.toLowerCase());
            if (!entry) continue;
            this.applyAdvisories(entry, toAdvisories(pkg.vulnerabilities));
            this.markVulnerableProject(entry, projectPath);
            if (!entry.projects.includes(projectPath)) entry.projects.push(projectPath);
          }
        }
      }
    }
  }

  /* ---------------------------- shared helpers --------------------------- */

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

  private useDotnetListForEnumeration(): boolean {
    return vscode.workspace
      .getConfiguration("nuget")
      .get<boolean>("useDotnetListForEnumeration", false);
  }

  private minimumPackageAgeDays(): number {
    const raw = vscode.workspace.getConfiguration("nuget").get<number>("minimumPackageAgeDays", 7);
    return Number.isFinite(raw) && raw > 0 ? raw : 0;
  }

  /**
   * Flag exact-version pins (`[x.y.z]`). Per-project pin state comes from the parsed
   * project / props model, so it is reliable regardless of the enrichment path.
   */
  private markPinned(merged: Map<string, InstalledPackage>): void {
    for (const project of this.projects.getProjects()) {
      for (const ref of project.parsed.packageReferences) {
        const key = ref.id.toLowerCase();
        const entry = merged.get(key);
        if (!entry) continue;
        let raw = ref.versionOverride || ref.version;
        if (!raw && project.info.usesCentralPackageManagement) {
          raw = project.cpm.versions.get(key)?.version ?? "";
        }
        const pv = entry.projectVersions.find((p) => p.project === project.info.path);
        if (pv) pv.pinned = isExactVersionPin(raw);
      }
    }

    for (const entry of merged.values()) {
      const direct = entry.projectVersions;
      entry.pinned = direct.length > 0 && direct.every((pv) => pv.pinned);
      if (entry.pinned) {
        const versions = new Set(direct.map((pv) => stripVersionPin(pv.version)));
        entry.pinnedVersion = versions.size === 1 ? [...versions][0] : undefined;
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
      const version = cleanVersion(entry.resolvedVersion || entry.requestedVersion || "");
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

/** `[1.2.3]` / `(1.0,2.0)` / `1.2.3` → `1.2.3` (first concrete version token). */
function cleanVersion(raw: string): string {
  return raw.replace(/[[\]()]/g, "").split(",")[0].trim();
}

export function projectDisplayName(projectPath: string): string {
  return path.basename(projectPath, path.extname(projectPath));
}
