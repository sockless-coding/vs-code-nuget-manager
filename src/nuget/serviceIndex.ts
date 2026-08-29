/**
 * NuGet v3 service index resolution.
 *
 * Every v3 feed exposes an `index.json` listing typed resources. Clients must
 * never hardcode resource URLs — they are read from here. See
 * https://learn.microsoft.com/nuget/api/service-index
 */

import { HttpClient } from "./httpClient";

export interface ServiceIndexResource {
  "@id": string;
  "@type": string;
  comment?: string;
}

export interface ResolvedResources {
  searchQueryService?: string;
  searchAutocompleteService?: string;
  registrationsBaseUrl?: string;
  packageBaseAddress?: string;
  packageDetailsUriTemplate?: string;
  readmeUriTemplate?: string;
}

const SERVICE_INDEX_TTL = 60 * 60 * 1000; // 1 hour

/** Prefer the most specific/newest resource type variant available. */
const RESOURCE_PREFERENCE: Record<keyof ResolvedResources, string[]> = {
  searchQueryService: ["SearchQueryService/3.5.0", "SearchQueryService/3.0.0-rc", "SearchQueryService/3.0.0-beta", "SearchQueryService"],
  searchAutocompleteService: [
    "SearchAutocompleteService/3.5.0",
    "SearchAutocompleteService/3.0.0-rc",
    "SearchAutocompleteService/3.0.0-beta",
    "SearchAutocompleteService"
  ],
  registrationsBaseUrl: [
    "RegistrationsBaseUrl/3.6.0",
    "RegistrationsBaseUrl/3.4.0",
    "RegistrationsBaseUrl/3.0.0-rc",
    "RegistrationsBaseUrl/3.0.0-beta",
    "RegistrationsBaseUrl"
  ],
  packageBaseAddress: ["PackageBaseAddress/3.0.0"],
  packageDetailsUriTemplate: ["PackageDetailsUriTemplate/5.1.0", "PackageDetailsUriTemplate"],
  readmeUriTemplate: ["ReadmeUriTemplate/6.13.0", "ReadmeUriTemplate"]
};

export class ServiceIndexCache {
  private inflight = new Map<string, Promise<ResolvedResources>>();

  constructor(private readonly http: HttpClient) {}

  async resolve(indexUrl: string): Promise<ResolvedResources> {
    const existing = this.inflight.get(indexUrl);
    if (existing) return existing;

    const p = this.load(indexUrl);
    this.inflight.set(indexUrl, p);
    try {
      return await p;
    } finally {
      // Keep successful results cached via HttpClient TTL; drop the inflight ref.
      this.inflight.delete(indexUrl);
    }
  }

  private async load(indexUrl: string): Promise<ResolvedResources> {
    const doc = await this.http.getJson<{ resources: ServiceIndexResource[] }>(indexUrl, {
      ttlMs: SERVICE_INDEX_TTL
    });
    const resources = doc.resources ?? [];
    const byType = new Map<string, string>();
    for (const r of resources) {
      if (r["@type"] && r["@id"] && !byType.has(r["@type"])) {
        byType.set(r["@type"], r["@id"]);
      }
    }

    const resolved: ResolvedResources = {};
    for (const key of Object.keys(RESOURCE_PREFERENCE) as (keyof ResolvedResources)[]) {
      for (const type of RESOURCE_PREFERENCE[key]) {
        const id = byType.get(type);
        if (id) {
          resolved[key] = stripTrailingSlash(id);
          break;
        }
      }
    }
    return resolved;
  }
}

function stripTrailingSlash(u: string): string {
  return u.endsWith("/") ? u.slice(0, -1) : u;
}
