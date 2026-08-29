import * as React from "react";
import type {
  InstallAction,
  InstalledPackage,
  PackageDetail,
  ProjectInfo
} from "../../panel/messaging";
import { formatDate, formatDownloads, severityLabel } from "../format";
import { request } from "../vscodeApi";

interface Props {
  detail: PackageDetail;
  projects: ProjectInfo[];
  installed: InstalledPackage[];
  includePrerelease: boolean;
  busy: boolean;
  onMutate: (action: InstallAction, version: string, projectPaths: string[]) => void;
}

export function PackageDetails({ detail, projects, installed, includePrerelease, busy, onMutate }: Props) {
  const installedForPackage = installed.find((p) => p.id.toLowerCase() === detail.id.toLowerCase());
  const installedProjectPaths = new Set(installedForPackage?.projects ?? []);

  const visibleVersions = detail.versions.filter((v) => includePrerelease || !v.isPrerelease);
  const [version, setVersion] = React.useState(detail.selectedVersion);
  React.useEffect(() => setVersion(detail.selectedVersion), [detail.id, detail.selectedVersion]);

  const [selectedProjects, setSelectedProjects] = React.useState<Set<string>>(new Set());
  React.useEffect(() => {
    // Preselect projects that already have the package (for update/uninstall),
    // otherwise all projects (for a fresh install).
    setSelectedProjects(
      installedProjectPaths.size > 0
        ? new Set(installedProjectPaths)
        : new Set(projects.map((p) => p.path))
    );
  }, [detail.id, projects.length]);

  const toggleProject = (path: string) => {
    setSelectedProjects((prev) => {
      const next = new Set(prev);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });
  };

  const chosen = [...selectedProjects];
  const anyChosen = chosen.length > 0;
  const chosenInstalled = chosen.filter((p) => installedProjectPaths.has(p));
  const chosenNotInstalled = chosen.filter((p) => !installedProjectPaths.has(p));

  const canInstall = anyChosen && chosenNotInstalled.length > 0;
  const canUpdate =
    anyChosen &&
    chosenInstalled.length > 0 &&
    chosenInstalled.some((path) => {
      const current =
        installedForPackage?.projectVersions.find((pv) => pv.project === path)?.version ??
        installedForPackage?.requestedVersion;
      return current !== version;
    });
  const canUninstall = anyChosen && chosenInstalled.length > 0;

  return (
    <div className="pkg-detail">
      <div className="pkg-detail-header">
        {detail.iconUrl ? (
          <img className="pkg-detail-icon" src={detail.iconUrl} alt="" />
        ) : (
          <span className="codicon codicon-package pkg-detail-icon" />
        )}
        <div>
          <h2>{detail.id}</h2>
          <div className="muted">
            {detail.authors.length > 0 && <span>by {detail.authors.join(", ")}</span>}
            {detail.source && <span className="chip">{detail.source}</span>}
          </div>
        </div>
      </div>

      {detail.deprecation && (
        <div className="callout callout-warn">
          <strong>Deprecated.</strong> {detail.deprecation.message || detail.deprecation.reasons.join(", ")}
          {detail.deprecation.alternatePackageId && <> Use <code>{detail.deprecation.alternatePackageId}</code> instead.</>}
        </div>
      )}
      {detail.vulnerabilities && detail.vulnerabilities.length > 0 && (
        <div className="callout callout-error">
          <strong>Known vulnerabilities:</strong>
          <ul>
            {detail.vulnerabilities.map((v, i) => (
              <li key={i}>
                {severityLabel(v.severity)} —{" "}
                <a href="#" onClick={(e) => (e.preventDefault(), request({ kind: "openExternal", url: v.advisoryUrl }))}>
                  advisory
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="pkg-detail-controls">
        <label>
          Version
          <select value={version} onChange={(e) => setVersion(e.target.value)} disabled={busy}>
            {visibleVersions.map((v) => (
              <option key={v.version} value={v.version}>
                {v.version}
                {v.isPrerelease ? "  (prerelease)" : ""}
                {v.published ? `  · ${formatDate(v.published)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="button-row">
          <button disabled={busy || !canInstall} onClick={() => onMutate("install", version, chosenNotInstalled)}>
            Install
          </button>
          <button disabled={busy || !canUpdate} onClick={() => onMutate("update", version, chosenInstalled)}>
            Update
          </button>
          <button
            className="danger"
            disabled={busy || !canUninstall}
            onClick={() => onMutate("uninstall", version, chosenInstalled)}
          >
            Uninstall
          </button>
        </div>
      </div>

      <div className="project-list">
        <div className="project-list-head">
          <span>Project</span>
          <span>Installed</span>
        </div>
        {projects.length === 0 && <div className="empty">No projects found in this workspace.</div>}
        {projects.map((p) => {
          const inst =
            installedForPackage?.projectVersions.find((pv) => pv.project === p.path)?.version ??
            (installedProjectPaths.has(p.path) ? installedForPackage?.requestedVersion ?? "—" : "—");
          return (
            <label key={p.path} className="project-row">
              <span>
                <input
                  type="checkbox"
                  checked={selectedProjects.has(p.path)}
                  onChange={() => toggleProject(p.path)}
                  disabled={busy}
                />
                {p.name}
                {p.usesCentralPackageManagement && <span className="chip" title="Central Package Management">CPM</span>}
              </span>
              <span className={inst === "—" ? "muted" : ""}>{inst}</span>
            </label>
          );
        })}
      </div>

      {detail.description && <p className="pkg-detail-desc">{detail.description}</p>}

      <div className="pkg-detail-links">
        {detail.projectUrl && (
          <a href="#" onClick={(e) => (e.preventDefault(), request({ kind: "openExternal", url: detail.projectUrl! }))}>
            Project site
          </a>
        )}
        {detail.licenseUrl && (
          <a href="#" onClick={(e) => (e.preventDefault(), request({ kind: "openExternal", url: detail.licenseUrl! }))}>
            License{detail.licenseExpression ? ` (${detail.licenseExpression})` : ""}
          </a>
        )}
        {!detail.licenseUrl && detail.licenseExpression && <span className="muted">License: {detail.licenseExpression}</span>}
      </div>

      {detail.dependencyGroups.length > 0 && (
        <details className="deps">
          <summary>Dependencies</summary>
          {detail.dependencyGroups.map((g) => (
            <div key={g.targetFramework}>
              <div className="deps-tfm">{g.targetFramework}</div>
              {g.dependencies.length === 0 ? (
                <div className="muted">No dependencies</div>
              ) : (
                <ul>
                  {g.dependencies.map((d) => (
                    <li key={d.id}>
                      {d.id} <span className="muted">{d.range}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </details>
      )}

      {detail.readmeMarkdown && (
        <details className="readme">
          <summary>Readme</summary>
          <pre>{detail.readmeMarkdown}</pre>
        </details>
      )}

      <div className="muted small">
        {(() => {
          const v = detail.versions.find((x) => x.version === version);
          const dl = v?.downloads;
          return dl ? `${formatDownloads(dl)} downloads of this version` : "";
        })()}
      </div>
    </div>
  );
}
