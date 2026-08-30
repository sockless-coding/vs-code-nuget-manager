/**
 * Pure planning helpers for the "Convert to Central Package Management" action.
 * No `vscode` / `fs` imports so they can be unit tested directly; the file I/O
 * and restore live in `cpmConvert.ts`.
 */

import { NuGetVersion } from "../nuget/NuGetVersion";
import { stripVersionPin } from "../nuget/versionRange";

export interface ProjectRefs {
  path: string;
  name: string;
  refs: { id: string; version: string }[];
}

export interface VersionBump {
  project: string;
  packageId: string;
  from: string;
  to: string;
}

/**
 * Resolve one central version per package id (highest wins) and list the
 * references that will be bumped to reach it.
 */
export function resolveCentralVersions(projects: ProjectRefs[]): {
  versions: { id: string; version: string }[];
  bumps: VersionBump[];
} {
  const byId = new Map<string, { id: string; raws: { project: string; version: string }[] }>();
  for (const project of projects) {
    for (const ref of project.refs) {
      if (!ref.version) continue;
      const key = ref.id.toLowerCase();
      const entry = byId.get(key) ?? { id: ref.id, raws: [] };
      entry.raws.push({ project: project.name, version: ref.version });
      byId.set(key, entry);
    }
  }

  const versions: { id: string; version: string }[] = [];
  const bumps: VersionBump[] = [];
  for (const { id, raws } of byId.values()) {
    const winner = pickHighestVersion(raws.map((r) => r.version));
    versions.push({ id, version: winner });
    const winnerCore = stripVersionPin(winner);
    for (const r of raws) {
      if (stripVersionPin(r.version) !== winnerCore) {
        bumps.push({ project: r.project, packageId: id, from: r.version, to: winner });
      }
    }
  }
  versions.sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
  bumps.sort((a, b) => a.project.localeCompare(b.project) || a.packageId.localeCompare(b.packageId));
  return { versions, bumps };
}

/** Highest of a list of version strings, keeping the winner's original text (pin brackets included). */
export function pickHighestVersion(raws: string[]): string {
  let best: string | undefined;
  let bestParsed: NuGetVersion | undefined;
  for (const raw of raws) {
    const parsed = NuGetVersion.tryParse(stripVersionPin(raw));
    if (!parsed) {
      best ??= raw;
      continue;
    }
    if (!bestParsed || NuGetVersion.compare(parsed, bestParsed) > 0) {
      best = raw;
      bestParsed = parsed;
    }
  }
  return best ?? raws[0] ?? "";
}

/** Read `<PackageVersion Include="X" Version="Y" />` items from props-file text. */
export function parsePackageVersionItems(text: string): { id: string; version: string }[] {
  const out: { id: string; version: string }[] = [];
  const re = /<PackageVersion\s+[^>]*?\bInclude\s*=\s*"([^"]+)"[^>]*?\bVersion\s*=\s*"([^"]*)"/gi;
  for (const m of text.matchAll(re)) {
    out.push({ id: m[1], version: m[2] });
  }
  return out;
}

/**
 * Merge already-central versions into `resolved`, keeping whichever is higher, so
 * enabling CPM on an existing props file never silently downgrades a package.
 */
export function mergeExistingVersions(
  resolved: { id: string; version: string }[],
  existing: { id: string; version: string }[]
): { id: string; version: string }[] {
  const byId = new Map(resolved.map((v) => [v.id.toLowerCase(), v]));
  for (const e of existing) {
    const key = e.id.toLowerCase();
    const current = byId.get(key);
    if (!current) {
      byId.set(key, e);
    } else {
      current.version = pickHighestVersion([current.version, e.version]);
    }
  }
  return [...byId.values()].sort((a, b) => a.id.toLowerCase().localeCompare(b.id.toLowerCase()));
}

/** Longest common directory prefix of `dirs` (case-insensitive, path-separator aware). */
export function commonAncestor(dirs: string[], sep: string): string {
  if (dirs.length === 0) return "";
  const parts = dirs.map((d) => d.split(sep));
  const first = parts[0];
  let i = 0;
  while (i < first.length && parts.every((p) => p[i]?.toLowerCase() === first[i].toLowerCase())) i++;
  return first.slice(0, i).join(sep);
}

/** Serialise a fresh `Directory.Packages.props` with CPM enabled and the given versions. */
export function buildPropsFile(versions: { id: string; version: string }[]): string {
  const items = versions
    .map((v) => `    <PackageVersion Include="${v.id}" Version="${v.version}" />`)
    .join("\n");
  return [
    "<Project>",
    "  <PropertyGroup>",
    "    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>",
    "  </PropertyGroup>",
    "  <ItemGroup>",
    items,
    "  </ItemGroup>",
    "</Project>",
    ""
  ].join("\n");
}
