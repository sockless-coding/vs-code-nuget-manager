/**
 * Pure `nuget.config` parsing and merging. No VS Code or filesystem dependencies
 * so it can be unit tested directly. Filesystem discovery lives in `feeds.ts`.
 *
 * Reference: https://learn.microsoft.com/nuget/reference/nuget-config-file
 */

import { XMLParser } from "fast-xml-parser";

export interface ConfigSource {
  key: string;
  value: string;
  protocolVersion?: string;
}

export interface ConfigCredential {
  sourceKey: string;
  username?: string;
  clearTextPassword?: string;
  /** DPAPI-encrypted; only decryptable on the machine/user that wrote it. */
  encryptedPassword?: string;
  validAuthenticationTypes?: string;
}

export interface ParsedNuGetConfig {
  /** `<clear />` seen inside `<packageSources>`. */
  clearPackageSources: boolean;
  sources: ConfigSource[];
  disabledSources: string[];
  credentials: ConfigCredential[];
  globalPackagesFolder?: string;
}

export interface ResolvedFeed {
  name: string;
  url: string;
  enabled: boolean;
  protocolVersion?: string;
  username?: string;
  clearTextPassword?: string;
  encryptedPassword?: string;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  parseAttributeValue: false,
  isArray: (name) => name === "add" || name === "clear"
});

function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

export function parseNuGetConfig(xml: string): ParsedNuGetConfig {
  const result: ParsedNuGetConfig = {
    clearPackageSources: false,
    sources: [],
    disabledSources: [],
    credentials: []
  };

  let doc: any;
  try {
    doc = parser.parse(xml);
  } catch {
    return result;
  }
  const config = doc?.configuration;
  if (!config) return result;

  // <packageSources>
  const ps = config.packageSources;
  if (ps) {
    if (toArray(ps.clear).length > 0) {
      result.clearPackageSources = true;
    }
    for (const add of toArray<any>(ps.add)) {
      const key = add["@_key"];
      const value = add["@_value"];
      if (typeof key === "string" && typeof value === "string") {
        result.sources.push({
          key,
          value,
          protocolVersion: add["@_protocolVersion"]
        });
      }
    }
  }

  // <disabledPackageSources>
  const dps = config.disabledPackageSources;
  if (dps) {
    for (const add of toArray<any>(dps.add)) {
      const key = add["@_key"];
      const value = String(add["@_value"] ?? "").toLowerCase();
      if (typeof key === "string" && value === "true") {
        result.disabledSources.push(key);
      }
    }
  }

  // <packageSourceCredentials><SourceKey><add key="Username" .../></SourceKey></...>
  const psc = config.packageSourceCredentials;
  if (psc && typeof psc === "object") {
    for (const [rawKey, node] of Object.entries<any>(psc)) {
      if (!node || typeof node !== "object") continue;
      const cred: ConfigCredential = { sourceKey: decodeSourceKey(rawKey) };
      for (const add of toArray<any>(node.add)) {
        const k = String(add["@_key"] ?? "").toLowerCase();
        const v = add["@_value"];
        if (k === "username") cred.username = v;
        else if (k === "cleartextpassword") cred.clearTextPassword = v;
        else if (k === "password") cred.encryptedPassword = v;
        else if (k === "validauthenticationtypes") cred.validAuthenticationTypes = v;
      }
      result.credentials.push(cred);
    }
  }

  // <config><add key="globalPackagesFolder" value="..." /></config>
  const cfg = config.config;
  if (cfg) {
    for (const add of toArray<any>(cfg.add)) {
      if (String(add["@_key"] ?? "").toLowerCase() === "globalpackagesfolder") {
        result.globalPackagesFolder = add["@_value"];
      }
    }
  }

  return result;
}

/** NuGet encodes non-alphanumeric chars in credential element names as `_x____`. */
function decodeSourceKey(name: string): string {
  return name.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Merge parsed configs. `configs` must be ordered from lowest to highest priority
 * (machine -> user -> repo root -> ... -> nearest). Nearest wins on key conflicts,
 * a `<clear/>` at any level drops everything accumulated below it.
 */
export function mergeConfigs(configs: ParsedNuGetConfig[]): ResolvedFeed[] {
  const sources = new Map<string, ConfigSource>();
  const disabled = new Set<string>();
  const credentials = new Map<string, ConfigCredential>();

  for (const cfg of configs) {
    if (cfg.clearPackageSources) {
      sources.clear();
    }
    for (const s of cfg.sources) {
      sources.set(s.key, s);
    }
    for (const d of cfg.disabledSources) {
      disabled.add(d);
    }
    for (const c of cfg.credentials) {
      credentials.set(c.sourceKey, c);
    }
  }

  return [...sources.values()].map((s) => {
    const cred = credentials.get(s.key);
    return {
      name: s.key,
      url: s.value,
      enabled: !disabled.has(s.key),
      protocolVersion: s.protocolVersion,
      username: cred?.username,
      clearTextPassword: cred?.clearTextPassword,
      encryptedPassword: cred?.encryptedPassword
    };
  });
}

/** True for a v3 feed (`index.json`) vs a v2 feed we cannot talk to. */
export function isV3Feed(feed: Pick<ResolvedFeed, "url" | "protocolVersion">): boolean {
  if (feed.protocolVersion === "3") return true;
  return /\/index\.json$/i.test(feed.url);
}
