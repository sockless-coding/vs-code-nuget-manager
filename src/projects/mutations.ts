/**
 * Applying install / update / uninstall.
 *
 *  - When the .NET SDK is available: `dotnet add/remove package` per project,
 *    then `dotnet restore` (when `nuget.autoRestore` is on).
 *  - Otherwise: string-splice the `.csproj` (and `Directory.Packages.props` under
 *    CPM) via `xmlEdit` so formatting is preserved, then try a restore if
 *    `dotnet` happens to exist, else report `restoreNeeded`.
 */

import * as fs from "fs";
import * as vscode from "vscode";
import { MutationRequest, MutationResult } from "../panel/messaging";
import { DotnetCli } from "../dotnet/cli";
import { ProjectRegistry, WorkspaceProject } from "./discovery";
import { projectDisplayName } from "./installed";
import {
  removePackageReference,
  removePackageVersion,
  upsertPackageReference,
  upsertPackageVersion
} from "./xmlEdit";

export class MutationService {
  constructor(
    private readonly projects: ProjectRegistry,
    private readonly dotnet: DotnetCli,
    private readonly output: vscode.OutputChannel
  ) {}

  async apply(req: MutationRequest, sourceUrl?: string): Promise<MutationResult> {
    const sdk = await this.dotnet.isAvailable();
    const result: MutationResult = {
      ok: true,
      action: req.action,
      packageId: req.packageId,
      perProject: [],
      usedFallback: !sdk,
      restoreNeeded: false
    };

    for (const projectPath of req.projectPaths) {
      const project = this.projects.findByPath(projectPath);
      if (!project) {
        result.perProject.push({ project: projectDisplayName(projectPath), ok: false, message: "Project not found" });
        result.ok = false;
        continue;
      }
      try {
        if (sdk) {
          await this.applyWithCli(req, project, sourceUrl);
        } else {
          this.applyWithXml(req, project);
          result.restoreNeeded = true;
        }
        result.perProject.push({ project: project.info.name, ok: true });
      } catch (err: any) {
        result.ok = false;
        result.perProject.push({ project: project.info.name, ok: false, message: err?.message ?? String(err) });
      }
    }

    if (result.ok && sdk && vscode.workspace.getConfiguration("nuget").get<boolean>("autoRestore", true)) {
      const r = await this.dotnet.restore();
      if (r.code !== 0) result.restoreNeeded = true;
    }

    await this.projects.refresh();
    return result;
  }

  private async applyWithCli(req: MutationRequest, project: WorkspaceProject, sourceUrl?: string): Promise<void> {
    if (req.action === "uninstall") {
      const r = await this.dotnet.removePackage(project.info.path, req.packageId);
      if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || "dotnet remove failed");
      return;
    }
    const r = await this.dotnet.addPackage(project.info.path, req.packageId, req.version, sourceUrl);
    if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || "dotnet add failed");
  }

  private applyWithXml(req: MutationRequest, project: WorkspaceProject): void {
    const useCpm = project.info.usesCentralPackageManagement && !!project.cpm.propsPath;
    this.output.appendLine(
      `[xml] ${req.action} ${req.packageId}${req.version ? "@" + req.version : ""} in ${project.info.name}${
        useCpm ? " (CPM)" : ""
      }`
    );

    if (req.action === "uninstall") {
      editFile(project.info.path, (t) => removePackageReference(t, req.packageId));
      if (useCpm) editFile(project.cpm.propsPath!, (t) => removePackageVersion(t, req.packageId));
      return;
    }

    if (!req.version) throw new Error("A target version is required");

    if (useCpm) {
      editFile(project.cpm.propsPath!, (t) => upsertPackageVersion(t, req.packageId, req.version!));
      editFile(project.info.path, (t) => upsertPackageReference(t, req.packageId, undefined));
    } else {
      editFile(project.info.path, (t) => upsertPackageReference(t, req.packageId, req.version));
    }
  }
}

function editFile(filePath: string, transform: (text: string) => string): void {
  const original = fs.readFileSync(filePath, "utf8");
  const updated = transform(original);
  if (updated !== original) {
    fs.writeFileSync(filePath, updated, "utf8");
  }
}

function lastLine(s: string): string {
  const lines = s.split(/\r\n|\n|\r/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? "";
}
