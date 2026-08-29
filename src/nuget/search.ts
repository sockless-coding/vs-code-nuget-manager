/**
 * Package search via the v3 SearchQueryService.
 * https://learn.microsoft.com/nuget/api/search-query-service-resource
 */

import { HttpClient } from "./httpClient";
import { ServiceIndexCache } from "./serviceIndex";
import { PackageSummary } from "../panel/messaging";

interface SearchResponse {
  totalHits: number;
  data: SearchResultEntry[];
}

interface SearchResultEntry {
  id: string;
  version: string;
  description?: string;
  summary?: string;
  title?: string;
  iconUrl?: string;
  licenseUrl?: string;
  projectUrl?: string;
  tags?: string[];
  authors?: string[] | string;
  totalDownloads?: number;
  verified?: boolean;
  packageTypes?: { name: string }[];
}

export interface SearchOptions {
  query: string;
  skip: number;
  take: number;
  includePrerelease: boolean;
  signal?: AbortSignal;
}

export class SearchService {
  constructor(private readonly http: HttpClient, private readonly indexes: ServiceIndexCache) {}

  async search(feedIndexUrl: string, feedName: string, opts: SearchOptions): Promise<{ results: PackageSummary[]; hasMore: boolean }> {
    const resources = await this.indexes.resolve(feedIndexUrl);
    if (!resources.searchQueryService) {
      return { results: [], hasMore: false };
    }

    const url = new URL(resources.searchQueryService);
    url.searchParams.set("q", opts.query);
    url.searchParams.set("skip", String(opts.skip));
    url.searchParams.set("take", String(opts.take));
    url.searchParams.set("prerelease", String(opts.includePrerelease));
    url.searchParams.set("semVerLevel", "2.0.0");

    const body = await this.http.getJson<SearchResponse>(url.toString(), {
      ttlMs: 60 * 1000,
      signal: opts.signal
    });

    const data = body.data ?? [];
    const results = data.map<PackageSummary>((entry) => ({
      id: entry.id,
      version: entry.version,
      description: entry.summary || entry.description || "",
      authors: normalizeAuthors(entry.authors),
      iconUrl: entry.iconUrl,
      totalDownloads: entry.totalDownloads,
      verified: entry.verified,
      projectUrl: entry.projectUrl,
      licenseUrl: entry.licenseUrl,
      tags: entry.tags,
      source: feedName
    }));

    return { results, hasMore: opts.skip + data.length < (body.totalHits ?? 0) };
  }
}

export function normalizeAuthors(authors: string[] | string | undefined): string[] {
  if (!authors) return [];
  if (Array.isArray(authors)) return authors;
  return authors
    .split(/[,;]/)
    .map((a) => a.trim())
    .filter(Boolean);
}

/**
 * Merge results from multiple feeds, keeping the highest-version entry per id and
 * preserving the original (relevance) ordering of the first feed that returned it.
 */
export function mergeSearchResults(lists: PackageSummary[][]): PackageSummary[] {
  const byId = new Map<string, PackageSummary>();
  const order: string[] = [];
  for (const list of lists) {
    for (const pkg of list) {
      const key = pkg.id.toLowerCase();
      if (!byId.has(key)) {
        byId.set(key, pkg);
        order.push(key);
      }
    }
  }
  return order.map((k) => byId.get(k)!);
}
