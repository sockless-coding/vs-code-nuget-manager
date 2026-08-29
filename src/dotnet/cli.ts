/**
 * Wrapper around the `dotnet` CLI. All package mutations and the fast installed/
 * outdated queries go through here when the SDK is available.
 */

import { execFile } from "child_process";
import * as vscode from "vscode";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class DotnetCli {
  private available: boolean | undefined;

  constructor(private readonly output: vscode.OutputChannel) {}

  private get exe(): string {
    return vscode.workspace.getConfiguration("nuget").get<string>("dotnetPath") || "dotnet";
  }

  async isAvailable(): Promise<boolean> {
    if (this.available !== undefined) return this.available;
    try {
      const r = await this.run(["--version"], undefined, true);
      this.available = r.code === 0;
    } catch {
      this.available = false;
    }
    return this.available;
  }

  invalidateAvailability(): void {
    this.available = undefined;
  }

  /** Run a dotnet command. `cwd` defaults to the first workspace folder. */
  run(args: string[], cwd?: string, quiet = false): Promise<RunResult> {
    const workingDir =
      cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    if (!quiet) {
      this.output.appendLine(`> dotnet ${args.join(" ")}  (${workingDir})`);
    }
    return new Promise((resolve, reject) => {
      execFile(
        this.exe,
        args,
        { cwd: workingDir, maxBuffer: 32 * 1024 * 1024, windowsHide: true },
        (err, stdout, stderr) => {
          if (!quiet) {
            if (stdout) this.output.append(stdout);
            if (stderr) this.output.append(stderr);
          }
          if (err && (err as NodeJS.ErrnoException).code === "ENOENT") {
            reject(new Error(`'${this.exe}' was not found. Set 'nuget.dotnetPath' or install the .NET SDK.`));
            return;
          }
          const code = typeof err?.code === "number" ? err.code : err ? 1 : 0;
          resolve({ code, stdout, stderr });
        }
      );
    });
  }

  async addPackage(projectPath: string, id: string, version?: string, sourceUrl?: string): Promise<RunResult> {
    const args = ["add", projectPath, "package", id];
    if (version) args.push("--version", version);
    if (sourceUrl) args.push("--source", sourceUrl);
    return this.run(args);
  }

  async removePackage(projectPath: string, id: string): Promise<RunResult> {
    return this.run(["remove", projectPath, "package", id]);
  }

  async restore(target?: string): Promise<RunResult> {
    return this.run(target ? ["restore", target] : ["restore"]);
  }

  /**
   * `dotnet list <target> package --format json`. `target` may be a project or
   * solution. Extra flags: `--outdated`, `--include-transitive`, `--deprecated`,
   * `--vulnerable`.
   */
  async listPackages(target: string, flags: string[] = []): Promise<DotnetListOutput | undefined> {
    const r = await this.run(["list", target, "package", "--format", "json", ...flags], undefined, true);
    if (r.code !== 0 && !r.stdout.trim().startsWith("{")) {
      return undefined;
    }
    try {
      return JSON.parse(r.stdout) as DotnetListOutput;
    } catch {
      return undefined;
    }
  }
}

export interface DotnetListOutput {
  version: number;
  projects: {
    path: string;
    frameworks?: {
      framework: string;
      topLevelPackages?: DotnetListPackage[];
      transitivePackages?: DotnetListPackage[];
    }[];
  }[];
}

export interface DotnetListPackage {
  id: string;
  requestedVersion?: string;
  resolvedVersion?: string;
  latestVersion?: string;
  deprecationReasons?: string[];
  vulnerabilities?: { severity: string; advisoryurl: string }[];
}
