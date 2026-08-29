/**
 * Reading MSBuild project files (`.csproj` / `.fsproj` / `.vbproj`).
 *
 * We only need a shallow view: target frameworks, direct PackageReference items,
 * and whether Central Package Management is switched on. Writing is done by
 * `mutations.ts` with string splicing so formatting is preserved.
 */

import { XMLParser } from "fast-xml-parser";

export interface ProjectPackageRef {
  id: string;
  /** Version as written (inline attribute or child element); empty under CPM. */
  version: string;
  versionOverride?: string;
}

export interface ParsedProject {
  targetFrameworks: string[];
  packageReferences: ProjectPackageRef[];
  /** `ManagePackageVersionsCentrally` value if set directly in this file. */
  managePackageVersionsCentrally?: boolean;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  isArray: (name) => name === "PackageReference" || name === "ItemGroup" || name === "PropertyGroup"
});

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseProject(xml: string): ParsedProject {
  const result: ParsedProject = { targetFrameworks: [], packageReferences: [] };
  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return result;
  }
  const project = doc?.Project;
  if (!project) return result;

  for (const pg of toArray<any>(project.PropertyGroup)) {
    const single = firstText(pg?.TargetFramework);
    const multi = firstText(pg?.TargetFrameworks);
    if (single) result.targetFrameworks.push(...splitFrameworks(single));
    if (multi) result.targetFrameworks.push(...splitFrameworks(multi));
    const cpm = firstText(pg?.ManagePackageVersionsCentrally);
    if (cpm !== undefined) {
      result.managePackageVersionsCentrally = /^true$/i.test(cpm);
    }
  }
  result.targetFrameworks = [...new Set(result.targetFrameworks)];

  for (const ig of toArray<any>(project.ItemGroup)) {
    for (const ref of toArray<any>(ig?.PackageReference)) {
      const id = ref["@_Include"] || ref["@_Update"];
      if (!id) continue;
      const version = ref["@_Version"] ?? childText(ref?.Version) ?? "";
      const versionOverride = ref["@_VersionOverride"] ?? childText(ref?.VersionOverride);
      result.packageReferences.push({ id: String(id), version: String(version), versionOverride });
    }
  }

  return result;
}

function splitFrameworks(v: string): string[] {
  return v
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

function firstText(node: any): string | undefined {
  if (node === undefined || node === null) return undefined;
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return firstText(node[0]);
  if (typeof node === "object" && "#text" in node) return String(node["#text"]);
  return undefined;
}

function childText(node: any): string | undefined {
  return firstText(node);
}
