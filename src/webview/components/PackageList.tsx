import type { InstalledPackage, PackageSummary } from "../../panel/messaging";
import { formatDownloads } from "../format";

export interface ListRow {
  id: string;
  title: string;
  description: string;
  authors: string[];
  iconUrl?: string;
  downloads?: number;
  verified?: boolean;
  rightLabel?: string;
  badge?: "deprecated" | "vulnerable";
}

export function summaryToRow(p: PackageSummary): ListRow {
  return {
    id: p.id,
    title: p.id,
    description: p.description,
    authors: p.authors,
    iconUrl: p.iconUrl,
    downloads: p.totalDownloads,
    verified: p.verified
  };
}

export function installedToRow(p: InstalledPackage): ListRow {
  const right = p.latestVersion && p.latestVersion !== p.requestedVersion
    ? `${p.requestedVersion} → ${p.latestVersion}`
    : p.requestedVersion || p.resolvedVersion || "";
  return {
    id: p.id,
    title: p.id,
    description: p.transitive ? "Transitive dependency" : `${p.projects.length} project${p.projects.length === 1 ? "" : "s"}`,
    authors: [],
    rightLabel: right,
    badge: p.hasVulnerability ? "vulnerable" : p.deprecated ? "deprecated" : undefined
  };
}

interface Props {
  rows: ListRow[];
  selectedId?: string;
  loading?: boolean;
  emptyMessage: string;
  onSelect: (id: string) => void;
  onLoadMore?: () => void;
  hasMore?: boolean;
}

export function PackageList({ rows, selectedId, loading, emptyMessage, onSelect, onLoadMore, hasMore }: Props) {
  return (
    <div className="pkg-list" role="listbox" aria-label="Packages">
      {rows.length === 0 && !loading && <div className="empty">{emptyMessage}</div>}
      {rows.map((row) => (
        <div
          key={row.id}
          role="option"
          aria-selected={row.id === selectedId}
          className={"pkg-row" + (row.id === selectedId ? " selected" : "")}
          onClick={() => onSelect(row.id)}
        >
          <div className="pkg-row-icon">
            {row.iconUrl ? (
              <img src={row.iconUrl} alt="" onError={(e) => ((e.target as HTMLImageElement).style.visibility = "hidden")} />
            ) : (
              <span className="codicon codicon-package" aria-hidden="true" />
            )}
          </div>
          <div className="pkg-row-body">
            <div className="pkg-row-title">
              <span className="pkg-row-id">{row.title}</span>
              {row.verified && <span className="codicon codicon-verified-filled verified" title="Verified owner" />}
              {row.badge === "deprecated" && <span className="badge badge-warn">deprecated</span>}
              {row.badge === "vulnerable" && <span className="badge badge-error">vulnerable</span>}
            </div>
            <div className="pkg-row-desc">{row.description}</div>
            <div className="pkg-row-meta">
              {row.authors.length > 0 && <span>by {row.authors.join(", ")}</span>}
              {row.downloads != null && (
                <span>
                  <span className="codicon codicon-cloud-download" /> {formatDownloads(row.downloads)}
                </span>
              )}
            </div>
          </div>
          {row.rightLabel && <div className="pkg-row-right">{row.rightLabel}</div>}
        </div>
      ))}
      {loading && <div className="loading">Loading…</div>}
      {hasMore && !loading && (
        <button className="load-more" onClick={onLoadMore}>
          Load more
        </button>
      )}
    </div>
  );
}
