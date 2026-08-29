/**
 * Version lists and per-version metadata.
 *
 *  - All versions come from the PackageBaseAddress "flat container"
 *    (`{base}/{id-lower}/index.json` -> `{ versions: [...] }`), which is the
 *    cheapest and most complete source.
 *  - Rich metadata (description, dependencies, deprecation, vulnerabilities) comes
 *    from the RegistrationsBaseUrl document for the package.
 *
 * https://learn.microsoft.com/nuget/api/package-base-address-resource
 * https://learn.microsoft.com/nuget/api/registration-base-url-resource
 */

import { HttpClient } from "./httpClient";
import { ServiceIndexCache } from "./serviceIndex";
import { NuGetVersion, sortVersionsDescending } from "./NuGetVersion";
import { normalizeAuthors } from "./search";
import {
  PackageDetail,
  PackageDependencyGroup,
  VersionInfo
} from "../panel/messaging";

interface FlatContainerIndex {
  versions: string[];
}

interface RegistrationIndex {
  items: RegistrationPage[];
}

interface RegistrationPage {
  "@id": string;
  lower?: string;
  upper?: string;
  items?: RegistrationLeaf[];
}

interface RegistrationLeaf {
  catalogEntry: CatalogEntry;
}

interface CatalogEntry {
  id: string;
  version: string;
  description?: string;
  authors?: string[] | string;
  iconUrl?: string;
  licenseUrl?: string;
  licenseExpression?: string;
  projectUrl?: string;
  tags?: string[] | string;
  published?: string;
  listed?: boolean;
  deprecation?: {
    reasons?: string[];
    message?: string;
    alternatePackage?: { id: string };
  };
  vulnerabilities?: { severity?: number | string; advisoryUrl: string }[];
  dependencyGroups?: {
    targetFramework?: string;
    dependencies?: { id: string; range?: string }[];
  }[];
}

export class MetadataService {
  constructor(private readonly http: HttpClient, private readonly indexes: ServiceIndexCache) {}

  /** All published versions, newest-first. */
  async listVersions(feedIndexUrl: string, packageId: string, signal?: AbortSignal): Promise<string[]> {
    const resources = await this.indexes.resolve(feedIndexUrl);
    if (!resources.packageBaseAddress) return [];
    const url = `${resources.packageBaseAddress}/${packageId.toLowerCase()}/index.json`;
    try {
      const doc = await this.http.getJson<FlatContainerIndex>(url, { ttlMs: 5 * 60 * 1000, signal });
      return sortVersionsDescending(doc.versions ?? []);
    } catch {
      return [];
    }
  }

  async getPackageDetail(
    feedIndexUrl: string,
    feedName: string,
    packageId: string,
    includePrerelease: boolean,
    signal?: AbortSignal
  ): Promise<PackageDetail> {
    const resources = await this.indexes.resolve(feedIndexUrl);

    const [allVersions, catalogByVersion] = await Promise.all([
      this.listVersions(feedIndexUrl, packageId, signal),
      this.loadCatalog(resources.registrationsBaseUrl, packageId, signal)
    ]);

    const versions: VersionInfo[] = allVersions.map((v) => {
      const parsed = NuGetVersion.tryParse(v);
      const entry = catalogByVersion.get(v.toLowerCase());
      return {
        version: v,
        isPrerelease: parsed?.isPrerelease ?? /-/.test(v),
        published: entry?.published
      };
    });

    const selectable = versions.filter((v) => includePrerelease || !v.isPrerelease);
    const selectedVersion = (selectable[0] ?? versions[0])?.version ?? "";
    const entry =
      catalogByVersion.get(selectedVersion.toLowerCase()) ??
      [...catalogByVersion.values()].pop();

    return {
      id: entry?.id ?? packageId,
      versions,
      selectedVersion,
      description: entry?.description ?? "",
      authors: normalizeAuthors(entry?.authors),
      iconUrl: entry?.iconUrl,
      projectUrl: entry?.projectUrl,
      licenseUrl: entry?.licenseUrl,
      licenseExpression: entry?.licenseExpression,
      tags: normalizeTags(entry?.tags),
      dependencyGroups: mapDependencyGroups(entry),
      deprecation: entry?.deprecation
        ? {
            reasons: entry.deprecation.reasons ?? [],
            message: entry.deprecation.message,
            alternatePackageId: entry.deprecation.alternatePackage?.id
          }
        : undefined,
      vulnerabilities: entry?.vulnerabilities?.map((v) => ({
        severity: typeof v.severity === "string" ? Number(v.severity) || 0 : v.severity ?? 0,
        advisoryUrl: v.advisoryUrl
      })),
      readmeMarkdown: await this.tryLoadReadme(resources.readmeUriTemplate, packageId, selectedVersion, signal),
      source: feedName
    };
  }

  private async loadCatalog(
    registrationsBaseUrl: string | undefined,
    packageId: string,
    signal?: AbortSignal
  ): Promise<Map<string, CatalogEntry>> {
    const map = new Map<string, CatalogEntry>();
    if (!registrationsBaseUrl) return map;

    const indexUrl = `${registrationsBaseUrl}/${packageId.toLowerCase()}/index.json`;
    let index: RegistrationIndex;
    try {
      index = await this.http.getJson<RegistrationIndex>(indexUrl, { ttlMs: 5 * 60 * 1000, signal });
    } catch {
      return map;
    }

    const pages = index.items ?? [];
    await Promise.all(
      pages.map(async (page) => {
        let leaves = page.items;
        if (!leaves) {
          try {
            const full = await this.http.getJson<RegistrationPage>(page["@id"], {
              ttlMs: 5 * 60 * 1000,
              signal
            });
            leaves = full.items ?? [];
          } catch {
            leaves = [];
          }
        }
        for (const leaf of leaves) {
          const ce = leaf.catalogEntry;
          if (ce?.version) {
            map.set(ce.version.toLowerCase(), ce);
          }
        }
      })
    );
    return map;
  }

  private async tryLoadReadme(
    template: string | undefined,
    packageId: string,
    version: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    if (!template || !version) return undefined;
    const url = template
      .replace("{lower_id}", packageId.toLowerCase())
      .replace("{lower_version}", version.toLowerCase());
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) return undefined;
      const text = await res.text();
      return text.length > 20_000 ? text.slice(0, 20_000) + "\n\n…" : text;
    } catch {
      return undefined;
    }
  }
}

function mapDependencyGroups(entry: CatalogEntry | undefined): PackageDependencyGroup[] {
  if (!entry?.dependencyGroups) return [];
  return entry.dependencyGroups.map((g) => ({
    targetFramework: g.targetFramework || "Any",
    dependencies: (g.dependencies ?? []).map((d) => ({ id: d.id, range: d.range || "" }))
  }));
}

function normalizeTags(tags: string[] | string | undefined): string[] {
  if (!tags) return [];
  if (Array.isArray(tags)) return tags;
  return tags.split(/\s+/).filter(Boolean);
}
