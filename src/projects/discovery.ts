/**
 * Discovers projects in the workspace and keeps a live model of them.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { EventEmitter } from "vscode";
import { ProjectInfo } from "../panel/messaging";
import { parseProject, ParsedProject } from "./projectFile";
import { readCpm, CpmInfo } from "./cpm";

const PROJECT_GLOB = "**/*.{csproj,fsproj,vbproj}";

export interface WorkspaceProject {
  info: ProjectInfo;
  parsed: ParsedProject;
  cpm: CpmInfo;
  workspaceRoot: string;
}

export class ProjectRegistry implements vscode.Disposable {
  private projects: WorkspaceProject[] = [];
  private solutions: SolutionInfo[] = [];
  private watcher?: vscode.FileSystemWatcher;
  private readonly _onDidChange = new EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  dispose(): void {
    this.watcher?.dispose();
    this._onDidChange.dispose();
  }

  start(): void {
    this.watcher = vscode.workspace.createFileSystemWatcher(
      "**/*.{csproj,fsproj,vbproj,props,sln,slnx}"
    );
    const refresh = debounce(() => this.refresh(), 400);
    this.watcher.onDidChange(refresh);
    this.watcher.onDidCreate(refresh);
    this.watcher.onDidDelete(refresh);
  }

  getProjects(): WorkspaceProject[] {
    return this.projects;
  }

  findByPath(projectPath: string): WorkspaceProject | undefined {
    const norm = path.resolve(projectPath).toLowerCase();
    return this.projects.find((p) => path.resolve(p.info.path).toLowerCase() === norm);
  }

  /**
   * Given the file the manager was opened from (a project, solution,
   * `Directory.Packages.props`, or `packages.config`), return the set of project
   * paths that entry point governs. An empty array means "no specific scope"
   * (e.g. opened from the command palette).
   */
  resolveSelectionScope(uri: vscode.Uri | undefined): string[] {
    if (!uri) return [];
    const target = path.resolve(uri.fsPath);
    const lower = target.toLowerCase();
    const base = path.basename(lower);
    const ext = path.extname(lower);

    if (/\.(csproj|fsproj|vbproj)$/.test(lower)) {
      const proj = this.findByPath(target);
      return proj ? [proj.info.path] : [];
    }

    if (base === "packages.config") {
      const dir = path.dirname(lower);
      return this.projects
        .filter((p) => path.dirname(path.resolve(p.info.path)).toLowerCase() === dir)
        .map((p) => p.info.path);
    }

    if (ext === ".sln" || ext === ".slnx") {
      const solution = this.solutions.find((s) => path.resolve(s.path).toLowerCase() === lower);
      if (!solution) return [];
      return this.projects
        .filter((p) => solution.projects.has(path.resolve(p.info.path).toLowerCase()))
        .map((p) => p.info.path);
    }

    if (base === "directory.packages.props") {
      return this.projects
        .filter((p) => p.cpm.propsPath && path.resolve(p.cpm.propsPath).toLowerCase() === lower)
        .map((p) => p.info.path);
    }

    return [];
  }

  async refresh(): Promise<void> {
    const uris = await vscode.workspace.findFiles(PROJECT_GLOB, "**/{node_modules,bin,obj}/**");
    const solutions = await findSolutions();
    this.solutions = solutions;

    const next: WorkspaceProject[] = [];
    for (const uri of uris) {
      const filePath = uri.fsPath;
      let xml: string;
      try {
        xml = fs.readFileSync(filePath, "utf8");
      } catch {
        continue;
      }
      const parsed = parseProject(xml);
      const workspaceRoot =
        vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? path.dirname(filePath);
      const cpm = readCpm(path.dirname(filePath), workspaceRoot);
      const usesCpm =
        parsed.managePackageVersionsCentrally ??
        (cpm.propsPath ? cpm.enabled : false);

      next.push({
        info: {
          path: filePath,
          name: path.basename(filePath, path.extname(filePath)),
          solution: solutions.find((s) => s.projects.has(filePath.toLowerCase()))?.path,
          targetFrameworks: parsed.targetFrameworks,
          usesCentralPackageManagement: usesCpm
        },
        parsed,
        cpm,
        workspaceRoot
      });
    }

    next.sort((a, b) => a.info.name.localeCompare(b.info.name));
    this.projects = next;
    this._onDidChange.fire();
  }
}

interface SolutionInfo {
  path: string;
  /** lower-cased absolute project paths. */
  projects: Set<string>;
}

async function findSolutions(): Promise<SolutionInfo[]> {
  const slnUris = await vscode.workspace.findFiles("**/*.{sln,slnx}", "**/{node_modules,bin,obj}/**");
  const solutions: SolutionInfo[] = [];
  for (const uri of slnUris) {
    try {
      const content = fs.readFileSync(uri.fsPath, "utf8");
      const dir = path.dirname(uri.fsPath);
      const projects = new Set<string>();
      if (uri.fsPath.endsWith(".slnx")) {
        for (const m of content.matchAll(/<Project\s+Path="([^"]+)"/g)) {
          projects.add(path.resolve(dir, m[1].replace(/\\/g, path.sep)).toLowerCase());
        }
      } else {
        for (const m of content.matchAll(/Project\("\{[^}]+\}"\)\s*=\s*"[^"]*",\s*"([^"]+)"/g)) {
          const rel = m[1].replace(/\\/g, path.sep);
          if (/\.(csproj|fsproj|vbproj)$/i.test(rel)) {
            projects.add(path.resolve(dir, rel).toLowerCase());
          }
        }
      }
      solutions.push({ path: uri.fsPath, projects });
    } catch {
      /* ignore unreadable solution */
    }
  }
  return solutions;
}

function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
  let handle: NodeJS.Timeout | undefined;
  return ((...args: any[]) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  }) as T;
}
