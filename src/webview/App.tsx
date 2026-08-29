import * as React from "react";
import type {
  FeedInfo,
  InstallAction,
  InstalledPackage,
  PackageDetail,
  PackageSummary,
  ProjectInfo
} from "../panel/messaging";
import { onHostEvent, onProgress, request } from "./vscodeApi";
import { PackageList, installedToRow, summaryToRow } from "./components/PackageList";
import { PackageDetails } from "./components/PackageDetails";

type Tab = "browse" | "installed" | "updates" | "consolidate";
const ALL_SOURCES = "All sources";
const PAGE_SIZE = 25;

export function App() {
  const [tab, setTab] = React.useState<Tab>("browse");
  const [includePrerelease, setIncludePrerelease] = React.useState(false);
  const [source, setSource] = React.useState(ALL_SOURCES);
  const [feeds, setFeeds] = React.useState<FeedInfo[]>([]);
  const [projects, setProjects] = React.useState<ProjectInfo[]>([]);

  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<PackageSummary[]>([]);
  const [hasMore, setHasMore] = React.useState(false);
  const [searching, setSearching] = React.useState(false);

  const [installed, setInstalled] = React.useState<InstalledPackage[]>([]);
  const [updates, setUpdates] = React.useState<InstalledPackage[]>([]);
  const [includeTransitive, setIncludeTransitive] = React.useState(false);
  const [sdkAvailable, setSdkAvailable] = React.useState(true);

  const [selectedId, setSelectedId] = React.useState<string | undefined>();
  const [detail, setDetail] = React.useState<PackageDetail | undefined>();
  const [detailLoading, setDetailLoading] = React.useState(false);

  const [busy, setBusy] = React.useState(false);
  const [progress, setProgress] = React.useState<string | undefined>();
  const [toast, setToast] = React.useState<string | undefined>();

  const searchSeq = React.useRef(0);

  /* ---------------------------- initial load ---------------------------- */
  React.useEffect(() => {
    request({ kind: "ready" }).then((r) => {
      setIncludePrerelease(r.initialState.defaultIncludePrerelease);
      setFeeds(r.initialState.feeds);
      setProjects(r.initialState.projects);
    });
    const offEvent = onHostEvent((event) => {
      if (event === "projectsChanged") {
        request({ kind: "listProjects" }).then((r) => setProjects(r.projects));
      }
      if (event === "installedChanged") {
        refreshInstalled();
        refreshUpdates();
      }
    });
    const offProgress = onProgress((message, done) => setProgress(done ? undefined : message));
    return () => {
      offEvent();
      offProgress();
    };
  }, []);

  /* ------------------------------- search ------------------------------- */
  const runSearch = React.useCallback(
    async (q: string, append: boolean) => {
      const seq = ++searchSeq.current;
      setSearching(true);
      try {
        const skip = append ? results.length : 0;
        const r = await request({
          kind: "search",
          query: q,
          skip,
          take: PAGE_SIZE,
          includePrerelease,
          source
        });
        if (seq !== searchSeq.current) return;
        setResults((prev) => (append ? [...prev, ...r.results] : r.results));
        setHasMore(r.hasMore);
      } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    },
    [results.length, includePrerelease, source]
  );

  React.useEffect(() => {
    if (tab !== "browse") return;
    const handle = setTimeout(() => runSearch(query, false), 300);
    return () => clearTimeout(handle);
  }, [query, includePrerelease, source, tab]);

  /* --------------------------- installed / updates --------------------- */
  const refreshInstalled = React.useCallback(async () => {
    const r = await request({ kind: "listInstalled", includeTransitive });
    setInstalled(r.packages);
    setSdkAvailable(r.sdkAvailable);
  }, [includeTransitive]);

  const refreshUpdates = React.useCallback(async () => {
    const r = await request({ kind: "listUpdates" });
    setUpdates(r.packages);
  }, []);

  React.useEffect(() => {
    refreshInstalled();
    refreshUpdates();
  }, [includeTransitive]);

  /* ------------------------------- detail ------------------------------ */
  React.useEffect(() => {
    if (!selectedId) {
      setDetail(undefined);
      return;
    }
    setDetailLoading(true);
    let cancelled = false;
    request({ kind: "getPackageDetail", packageId: selectedId, source, includePrerelease })
      .then((r) => !cancelled && setDetail(r.detail))
      .catch((e) => !cancelled && setToast(String(e.message ?? e)))
      .finally(() => !cancelled && setDetailLoading(false));
    return () => {
      cancelled = true;
    };
  }, [selectedId, source, includePrerelease]);

  /* ------------------------------ mutate ------------------------------- */
  const onMutate = async (action: InstallAction, version: string, projectPaths: string[]) => {
    if (projectPaths.length === 0) return;
    setBusy(true);
    setToast(undefined);
    try {
      const r = await request({
        kind: "mutate",
        request: { action, packageId: selectedId!, version, projectPaths, source: detail?.source }
      });
      const failed = r.result.perProject.filter((p) => !p.ok);
      if (r.result.ok) {
        setToast(
          `${labelFor(action)} ${r.result.packageId}${r.result.restoreNeeded ? " — run 'dotnet restore' to finish" : ""}`
        );
      } else {
        setToast(`${labelFor(action)} failed for ${failed.map((f) => f.project).join(", ")}: ${failed[0]?.message ?? ""}`);
      }
      await refreshInstalled();
      await refreshUpdates();
    } catch (e: any) {
      setToast(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const updateAll = async () => {
    for (const pkg of updates) {
      if (!pkg.latestVersion) continue;
      setBusy(true);
      try {
        await request({
          kind: "mutate",
          request: {
            action: "update",
            packageId: pkg.id,
            version: pkg.latestVersion,
            projectPaths: pkg.projects
          }
        });
      } catch {
        /* keep going */
      }
    }
    setBusy(false);
    setToast("Updated all packages");
    await refreshInstalled();
    await refreshUpdates();
  };

  /* --------------------------- derived rows --------------------------- */
  const consolidatable = React.useMemo(() => groupInconsistent(installed), [installed]);

  const rows =
    tab === "browse"
      ? results.map(summaryToRow)
      : tab === "installed"
      ? installed.map(installedToRow)
      : tab === "updates"
      ? updates.map(installedToRow)
      : consolidatable.map(installedToRow);

  return (
    <div className="app">
      <header className="toolbar">
        <div className="search-box">
          <span className="codicon codicon-search" />
          <input
            type="text"
            placeholder="Search packages (e.g. Newtonsoft.Json)"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setTab("browse");
            }}
          />
        </div>
        <label className="prerelease-toggle">
          <input type="checkbox" checked={includePrerelease} onChange={(e) => setIncludePrerelease(e.target.checked)} />
          Include prerelease
        </label>
        <label className="source-select">
          Source
          <select value={source} onChange={(e) => setSource(e.target.value)}>
            <option value={ALL_SOURCES}>{ALL_SOURCES}</option>
            {feeds.filter((f) => f.enabled).map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
                {f.requiresAuth ? " 🔒" : ""}
              </option>
            ))}
          </select>
        </label>
      </header>

      <nav className="tabs">
        <button className={tab === "browse" ? "active" : ""} onClick={() => setTab("browse")}>
          Browse
        </button>
        <button className={tab === "installed" ? "active" : ""} onClick={() => setTab("installed")}>
          Installed <span className="count">{installed.length}</span>
        </button>
        <button className={tab === "updates" ? "active" : ""} onClick={() => setTab("updates")}>
          Updates {updates.length > 0 && <span className="count accent">{updates.length}</span>}
        </button>
        <button className={tab === "consolidate" ? "active" : ""} onClick={() => setTab("consolidate")}>
          Consolidate {consolidatable.length > 0 && <span className="count">{consolidatable.length}</span>}
        </button>
        <span className="spacer" />
        {tab === "installed" && (
          <label className="transitive-toggle">
            <input type="checkbox" checked={includeTransitive} onChange={(e) => setIncludeTransitive(e.target.checked)} />
            Include transitive
          </label>
        )}
        {tab === "updates" && updates.length > 0 && (
          <button className="primary" disabled={busy} onClick={updateAll}>
            Update All
          </button>
        )}
      </nav>

      {!sdkAvailable && (
        <div className="banner">
          .NET SDK not detected — changes are written directly to project files. Run <code>dotnet restore</code> afterwards.
        </div>
      )}
      {progress && <div className="banner">{progress}</div>}

      <div className="content">
        <div className="list-pane">
          <PackageList
            rows={rows}
            selectedId={selectedId}
            loading={tab === "browse" ? searching : false}
            emptyMessage={emptyMessageFor(tab, query)}
            onSelect={setSelectedId}
            onLoadMore={() => runSearch(query, true)}
            hasMore={tab === "browse" && hasMore}
          />
        </div>
        <div className="detail-pane">
          {detailLoading && <div className="loading">Loading package…</div>}
          {!detailLoading && detail && (
            <PackageDetails
              detail={detail}
              projects={projects}
              installed={installed}
              includePrerelease={includePrerelease}
              busy={busy}
              onMutate={onMutate}
            />
          )}
          {!detailLoading && !detail && <div className="empty">Select a package to see details.</div>}
        </div>
      </div>

      {toast && (
        <div className="toast" onClick={() => setToast(undefined)}>
          {toast}
        </div>
      )}
    </div>
  );
}

function labelFor(action: InstallAction): string {
  return action === "install" ? "Installed" : action === "update" ? "Updated" : "Uninstalled";
}

function emptyMessageFor(tab: Tab, query: string): string {
  switch (tab) {
    case "browse":
      return query ? "No packages match your search." : "Type to search the configured NuGet feeds.";
    case "installed":
      return "No packages installed in this workspace.";
    case "updates":
      return "All packages are up to date.";
    case "consolidate":
      return "All packages use a consistent version across projects.";
  }
}

/** Packages referenced at more than one distinct version across projects. */
function groupInconsistent(installed: InstalledPackage[]): InstalledPackage[] {
  return installed.filter((p) => {
    if (p.transitive) return false;
    const distinct = new Set(p.projectVersions.map((pv) => pv.version));
    return distinct.size > 1;
  });
}
