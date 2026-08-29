/**
 * Typed message protocol between the extension host and the webview.
 *
 * The webview sends `WebviewRequest` messages; the host answers a request with a
 * `HostResponse` carrying the same `id`, and may also push unsolicited `HostEvent`
 * messages (e.g. project changes detected on disk).
 */

export interface PackageSummary {
  id: string;
  version: string;
  description: string;
  authors: string[];
  iconUrl?: string;
  totalDownloads?: number;
  verified?: boolean;
  projectUrl?: string;
  licenseUrl?: string;
  tags?: string[];
  /** Source feed name this result came from. */
  source: string;
}

export interface PackageDependency {
  id: string;
  range: string;
}

export interface PackageDependencyGroup {
  targetFramework: string;
  dependencies: PackageDependency[];
}

export interface PackageDetail {
  id: string;
  /** All versions, already sorted newest-first by NuGet version rules. */
  versions: VersionInfo[];
  selectedVersion: string;
  description: string;
  authors: string[];
  iconUrl?: string;
  projectUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  readmeMarkdown?: string;
  tags: string[];
  dependencyGroups: PackageDependencyGroup[];
  deprecation?: { reasons: string[]; message?: string; alternatePackageId?: string };
  vulnerabilities?: { severity: number; advisoryUrl: string }[];
  source: string;
}

export interface VersionInfo {
  version: string;
  isPrerelease: boolean;
  downloads?: number;
  published?: string;
}

export interface ProjectInfo {
  /** Absolute path to the project file. */
  path: string;
  name: string;
  /** Path to the solution that groups this project, if any. */
  solution?: string;
  targetFrameworks: string[];
  usesCentralPackageManagement: boolean;
}

export interface InstalledPackage {
  id: string;
  /** Requested version / version range as written in the project or props file. */
  requestedVersion: string;
  /** Resolved version after restore, when known. */
  resolvedVersion?: string;
  /** Project paths that reference this package directly. */
  projects: string[];
  /** Direct reference version per project — basis for the Consolidate view. */
  projectVersions: { project: string; version: string }[];
  /** True when only present transitively (no direct PackageReference). */
  transitive: boolean;
  latestVersion?: string;
  latestStableVersion?: string;
  deprecated?: boolean;
  hasVulnerability?: boolean;
}

export interface FeedInfo {
  name: string;
  url: string;
  enabled: boolean;
  requiresAuth: boolean;
}

export type InstallAction = "install" | "update" | "uninstall";

export interface MutationRequest {
  action: InstallAction;
  packageId: string;
  version?: string;
  projectPaths: string[];
  source?: string;
}

export interface MutationResult {
  ok: boolean;
  action: InstallAction;
  packageId: string;
  perProject: { project: string; ok: boolean; message?: string }[];
  usedFallback: boolean;
  restoreNeeded: boolean;
}

/* ------------------------------- Requests -------------------------------- */

export type WebviewRequest =
  | { kind: "ready" }
  | { kind: "search"; query: string; skip: number; take: number; includePrerelease: boolean; source: string }
  | { kind: "getPackageDetail"; packageId: string; source: string; includePrerelease: boolean }
  | { kind: "listProjects" }
  | { kind: "listInstalled"; includeTransitive: boolean }
  | { kind: "listUpdates" }
  | { kind: "listFeeds" }
  | { kind: "mutate"; request: MutationRequest }
  | { kind: "openExternal"; url: string };

export type WebviewMessage = WebviewRequest & { id: number };

/* ------------------------------- Responses ------------------------------- */

export type HostResponsePayload =
  | { kind: "search"; results: PackageSummary[]; hasMore: boolean }
  | { kind: "getPackageDetail"; detail: PackageDetail }
  | { kind: "listProjects"; projects: ProjectInfo[] }
  | { kind: "listInstalled"; packages: InstalledPackage[]; sdkAvailable: boolean }
  | { kind: "listUpdates"; packages: InstalledPackage[] }
  | { kind: "listFeeds"; feeds: FeedInfo[] }
  | { kind: "mutate"; result: MutationResult }
  | { kind: "openExternal" }
  | { kind: "ready"; initialState: InitialState };

export interface InitialState {
  defaultIncludePrerelease: boolean;
  feeds: FeedInfo[];
  projects: ProjectInfo[];
}

export type HostResponse =
  | { id: number; ok: true; payload: HostResponsePayload }
  | { id: number; ok: false; error: string };

export type HostEvent =
  | { type: "event"; event: "projectsChanged" }
  | { type: "event"; event: "installedChanged" }
  | { type: "event"; event: "progress"; message: string; done: boolean };

export type HostMessage = ({ type: "response" } & HostResponse) | HostEvent;
