/**
 * Reads the resolved dependency graph from `obj/project.assets.json` (written by
 * `dotnet restore`). This is the only place that knows *why* a transitive package
 * is present — `dotnet list package` reports the flat set but not the edges.
 *
 * The `logs` array also carries NuGet audit warnings (NU1901-NU1904), which give
 * a network-free vulnerability source used as the no-SDK fallback.
 *
 * https://learn.microsoft.com/nuget/reference/nuget-client-sdk#restore-outputs
 */

import * as fs from "fs";
import * as path from "path";

export interface Advisory {
  /** 0 Low, 1 Moderate, 2 High, 3 Critical. */
  severity: number;
  advisoryUrl: string;
}

export interface DependencyGraph {
  /** idLower -> ids it depends on directly (idLower). */
  dependencies: Map<string, Set<string>>;
  /** idLower -> ids that depend on it directly (idLower). */
  dependents: Map<string, Set<string>>;
  /** idLower of packages referenced directly by a project. */
  topLevel: Set<string>;
  /** idLower -> resolved version, taken from the restore `targets` section. */
  resolved: Map<string, string>;
  /** idLower -> original casing seen in the assets file. */
  displayName: Map<string, string>;
  /** idLower -> advisories parsed from the audit logs. */
  vulnerabilities: Map<string, Advisory[]>;
}

/** NU1901..NU1904 map straight onto severity 0..3. */
const AUDIT_CODE_SEVERITY: Record<string, number> = {
  NU1901: 0,
  NU1902: 1,
  NU1903: 2,
  NU1904: 3
};

const SEVERITY_WORDS: Record<string, number> = {
  low: 0,
  moderate: 1,
  medium: 1,
  high: 2,
  critical: 3
};

function emptyGraph(): DependencyGraph {
  return {
    dependencies: new Map(),
    dependents: new Map(),
    topLevel: new Set(),
    resolved: new Map(),
    displayName: new Map(),
    vulnerabilities: new Map()
  };
}

function addEdge(graph: DependencyGraph, parent: string, child: string): void {
  const p = parent.toLowerCase();
  const c = child.toLowerCase();
  if (p === c) return;
  (graph.dependencies.get(p) ?? setInMap(graph.dependencies, p)).add(c);
  (graph.dependents.get(c) ?? setInMap(graph.dependents, c)).add(p);
}

function setInMap(map: Map<string, Set<string>>, key: string): Set<string> {
  const s = new Set<string>();
  map.set(key, s);
  return s;
}

function note(graph: DependencyGraph, id: string): void {
  const key = id.toLowerCase();
  if (!graph.displayName.has(key)) graph.displayName.set(key, id);
}

/** Parse a `project.assets.json` document (already JSON-parsed) into a graph. */
export function buildGraph(assets: unknown): DependencyGraph {
  const graph = emptyGraph();
  if (!assets || typeof assets !== "object") return graph;
  const doc = assets as Record<string, any>;

  for (const target of Object.values(doc.targets ?? {})) {
    if (!target || typeof target !== "object") continue;
    for (const [key, entry] of Object.entries(target as Record<string, any>)) {
      const [parentId, parentVersion] = key.split("/");
      if (!parentId) continue;
      if (entry?.type && entry.type !== "package") continue;
      note(graph, parentId);
      if (parentVersion && !graph.resolved.has(parentId.toLowerCase())) {
        graph.resolved.set(parentId.toLowerCase(), parentVersion);
      }
      for (const childId of Object.keys(entry?.dependencies ?? {})) {
        note(graph, childId);
        addEdge(graph, parentId, childId);
      }
    }
  }

  for (const group of Object.values(doc.projectFileDependencyGroups ?? {})) {
    for (const spec of (group as string[]) ?? []) {
      const id = String(spec).trim().split(/[\s(]/)[0];
      if (id) {
        note(graph, id);
        graph.topLevel.add(id.toLowerCase());
      }
    }
  }

  for (const log of (doc.logs as any[]) ?? []) {
    if (!log || log.level !== "Warning") continue;
    const severity = auditSeverity(log.code, log.message);
    if (severity < 0 || !log.libraryId) continue;
    const url = extractUrl(log.message);
    const key = String(log.libraryId).toLowerCase();
    note(graph, String(log.libraryId));
    const list = graph.vulnerabilities.get(key) ?? [];
    if (!list.some((a) => a.advisoryUrl === url)) {
      list.push({ severity, advisoryUrl: url });
    }
    graph.vulnerabilities.set(key, list);
  }

  return graph;
}

function auditSeverity(code: unknown, message: unknown): number {
  if (typeof code === "string" && code in AUDIT_CODE_SEVERITY) {
    return AUDIT_CODE_SEVERITY[code];
  }
  const text = String(message ?? "").toLowerCase();
  for (const [word, sev] of Object.entries(SEVERITY_WORDS)) {
    if (text.includes(`${word} severity`)) return sev;
  }
  return -1;
}

function extractUrl(message: unknown): string {
  const m = /https?:\/\/\S+/.exec(String(message ?? ""));
  return m ? m[0].replace(/[.,)]+$/, "") : "";
}

/** Read `<projectDir>/obj/project.assets.json`; `undefined` when missing/unreadable. */
export function readAssetsGraph(projectDir: string): DependencyGraph | undefined {
  const file = path.join(projectDir, "obj", "project.assets.json");
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return buildGraph(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Async variant, so a whole solution's assets files can be read in parallel. */
export async function readAssetsGraphAsync(projectDir: string): Promise<DependencyGraph | undefined> {
  const file = path.join(projectDir, "obj", "project.assets.json");
  let raw: string;
  try {
    raw = await fs.promises.readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return buildGraph(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function mergeGraphs(graphs: (DependencyGraph | undefined)[]): DependencyGraph {
  const merged = emptyGraph();
  for (const g of graphs) {
    if (!g) continue;
    for (const [k, v] of g.displayName) if (!merged.displayName.has(k)) merged.displayName.set(k, v);
    for (const [k, v] of g.resolved) if (!merged.resolved.has(k)) merged.resolved.set(k, v);
    for (const k of g.topLevel) merged.topLevel.add(k);
    for (const [k, set] of g.dependencies) {
      const into = merged.dependencies.get(k) ?? setInMap(merged.dependencies, k);
      for (const c of set) into.add(c);
    }
    for (const [k, set] of g.dependents) {
      const into = merged.dependents.get(k) ?? setInMap(merged.dependents, k);
      for (const c of set) into.add(c);
    }
    for (const [k, list] of g.vulnerabilities) {
      const into = merged.vulnerabilities.get(k) ?? [];
      for (const a of list) if (!into.some((x) => x.advisoryUrl === a.advisoryUrl)) into.push(a);
      merged.vulnerabilities.set(k, into);
    }
  }
  return merged;
}
