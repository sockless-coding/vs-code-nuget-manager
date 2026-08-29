/**
 * Feed discovery and authentication.
 *
 * Sources, in increasing priority:
 *   1. machine-level nuget config
 *   2. user-level nuget config (%AppData%\NuGet\NuGet.Config, ~/.nuget/NuGet/NuGet.Config,
 *      ~/.config/NuGet/NuGet.Config)
 *   3. every `nuget.config` / `NuGet.Config` found walking up from each workspace folder
 *   4. `nuget.additionalSources` from VS Code settings
 *
 * When a feed needs auth we use, in order: ClearTextPassword from config, a token
 * previously saved in VS Code SecretStorage, or an interactive prompt (stored for
 * next time). DPAPI-encrypted `<Password>` values cannot be read cross-platform,
 * so those feeds fall through to the prompt.
 */

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import {
  ParsedNuGetConfig,
  ResolvedFeed,
  isV3Feed,
  mergeConfigs,
  parseNuGetConfig
} from "./nugetConfig";
import { hostOf } from "./httpClient";

export interface Feed {
  name: string;
  /** v3 service index URL (`.../index.json`). */
  url: string;
  enabled: boolean;
  isV3: boolean;
  username?: string;
  clearTextPassword?: string;
  hasEncryptedPassword: boolean;
}

const SECRET_PREFIX = "nuget.feedToken:";

export class FeedRegistry {
  private feeds: Feed[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {}

  getFeeds(): Feed[] {
    return this.feeds;
  }

  getEnabledV3Feeds(): Feed[] {
    return this.feeds.filter((f) => f.enabled && f.isV3);
  }

  findByName(name: string): Feed | undefined {
    return this.feeds.find((f) => f.name === name);
  }

  refresh(): void {
    const configs = collectConfigFiles().map((file) => safeParse(file));
    const merged = mergeConfigs(configs);

    const additional = vscode.workspace
      .getConfiguration("nuget")
      .get<{ name: string; url: string }[]>("additionalSources", []);

    const feeds: Feed[] = merged.map(toFeed);
    for (const a of additional) {
      if (!a?.url) continue;
      if (feeds.some((f) => f.url === a.url)) continue;
      feeds.push({
        name: a.name || hostOf(a.url),
        url: a.url,
        enabled: true,
        isV3: isV3Feed({ url: a.url }),
        hasEncryptedPassword: false
      });
    }

    if (feeds.length === 0) {
      feeds.push({
        name: "nuget.org",
        url: "https://api.nuget.org/v3/index.json",
        enabled: true,
        isV3: true,
        hasEncryptedPassword: false
      });
    }
    this.feeds = feeds;
  }

  /** Returns an `Authorization` header value for a request URL, or undefined. */
  async getAuthHeader(requestUrl: string): Promise<string | undefined> {
    const host = hostOf(requestUrl);
    const feed = this.feeds.find((f) => hostOf(f.url) === host);
    if (!feed) return undefined;

    if (feed.clearTextPassword) {
      return basic(feed.username ?? "nuget", feed.clearTextPassword);
    }
    const saved = await this.context.secrets.get(SECRET_PREFIX + feed.name);
    if (saved) {
      return basic(feed.username ?? "nuget", saved);
    }
    return undefined;
  }

  /** Prompt for a token/PAT and persist it for the feed. Returns true if saved. */
  async promptForCredentials(feedName: string): Promise<boolean> {
    const feed = this.findByName(feedName);
    if (!feed) return false;

    const token = await vscode.window.showInputBox({
      title: `Credentials for ${feed.name}`,
      prompt: `Enter a personal access token / password for ${hostOf(feed.url)}`,
      password: true,
      ignoreFocusOut: true
    });
    if (!token) return false;
    await this.context.secrets.store(SECRET_PREFIX + feed.name, token);
    return true;
  }

  async clearCredentials(feedName: string): Promise<void> {
    await this.context.secrets.delete(SECRET_PREFIX + feedName);
  }
}

function toFeed(r: ResolvedFeed): Feed {
  return {
    name: r.name,
    url: r.url,
    enabled: r.enabled,
    isV3: isV3Feed(r),
    username: r.username,
    clearTextPassword: r.clearTextPassword,
    hasEncryptedPassword: !!r.encryptedPassword
  };
}

function safeParse(file: string): ParsedNuGetConfig {
  try {
    return parseNuGetConfig(fs.readFileSync(file, "utf8"));
  } catch {
    return { clearPackageSources: false, sources: [], disabledSources: [], credentials: [] };
  }
}

function basic(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

/** Ordered lowest → highest priority. */
function collectConfigFiles(): string[] {
  const files: string[] = [];

  // User / machine level.
  const home = os.homedir();
  const candidates =
    process.platform === "win32"
      ? [
          path.join(process.env.ProgramFiles ?? "C:\\Program Files", "NuGet", "Config", "NuGet.Config"),
          path.join(process.env.APPDATA ?? path.join(home, "AppData", "Roaming"), "NuGet", "NuGet.Config")
        ]
      : [
          "/etc/NuGet/NuGet.Config",
          path.join(home, ".nuget", "NuGet", "NuGet.Config"),
          path.join(home, ".config", "NuGet", "NuGet.Config")
        ];
  for (const c of candidates) {
    if (fileExists(c)) files.push(c);
  }

  // Walk up from each workspace folder, collecting configs; add them so that
  // the deepest (nearest to the folder) has the highest priority.
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    const chain: string[] = [];
    let dir = folder.uri.fsPath;
    let prev = "";
    while (dir && dir !== prev) {
      for (const name of ["nuget.config", "NuGet.Config", "NuGet.config"]) {
        const p = path.join(dir, name);
        if (fileExists(p)) {
          chain.push(p);
          break;
        }
      }
      prev = dir;
      dir = path.dirname(dir);
    }
    // chain is nearest-first; reverse so nearest ends up last (highest priority).
    files.push(...chain.reverse());
  }

  return dedupe(files);
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function dedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const i of items) {
    const key = process.platform === "win32" ? i.toLowerCase() : i;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(i);
    }
  }
  return out;
}
