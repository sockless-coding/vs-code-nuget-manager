/**
 * Central Package Management support.
 *
 * When a `Directory.Packages.props` file exists above a project and
 * `ManagePackageVersionsCentrally` is not `false`, package versions live in
 * `<PackageVersion Include="..." Version="..." />` items in that props file and
 * the project carries bare `<PackageReference Include="..." />`.
 * https://learn.microsoft.com/nuget/consume-packages/central-package-management
 */

import * as fs from "fs";
import * as path from "path";
import { XMLParser } from "fast-xml-parser";

export interface CpmInfo {
  /** Absolute path to the governing Directory.Packages.props, if any. */
  propsPath?: string;
  enabled: boolean;
  /** Map of package id (lower-case) -> version string. */
  versions: Map<string, { id: string; version: string }>;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  isArray: (name) => name === "PackageVersion" || name === "ItemGroup" || name === "PropertyGroup"
});

/** Walk up from `startDir` (inclusive) to `stopDir` (inclusive) looking for the props file. */
export function findDirectoryPackagesProps(startDir: string, stopDir: string): string | undefined {
  let dir = path.resolve(startDir);
  const stop = path.resolve(stopDir);
  // Guard against startDir not being under stopDir.
  const underStop = dir.toLowerCase().startsWith(stop.toLowerCase());
  let prev = "";
  while (dir && dir !== prev) {
    const candidate = path.join(dir, "Directory.Packages.props");
    if (fs.existsSync(candidate)) return candidate;
    if (underStop && dir.toLowerCase() === stop.toLowerCase()) break;
    prev = dir;
    dir = path.dirname(dir);
  }
  return undefined;
}

export function readCpm(projectDir: string, workspaceRoot: string): CpmInfo {
  const propsPath = findDirectoryPackagesProps(projectDir, workspaceRoot);
  const info: CpmInfo = { propsPath, enabled: false, versions: new Map() };
  if (!propsPath) return info;

  let doc: any;
  try {
    doc = parser.parse(fs.readFileSync(propsPath, "utf8"));
  } catch {
    return info;
  }
  const project = doc?.Project;
  if (!project) return info;

  info.enabled = true; // default is true when the file exists
  for (const pg of asArray(project.PropertyGroup)) {
    const raw = textOf(pg?.ManagePackageVersionsCentrally);
    if (raw !== undefined) {
      info.enabled = /^true$/i.test(raw);
    }
  }

  for (const ig of asArray(project.ItemGroup)) {
    for (const pv of asArray(ig?.PackageVersion)) {
      const id = pv["@_Include"];
      const version = pv["@_Version"] ?? textOf(pv?.Version) ?? "";
      if (id) {
        info.versions.set(String(id).toLowerCase(), { id: String(id), version: String(version) });
      }
    }
  }
  return info;
}

function asArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function textOf(node: any): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return textOf(node[0]);
  if (typeof node === "object" && "#text" in node) return String(node["#text"]);
  return undefined;
}
