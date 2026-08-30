/**
 * Helpers for NuGet exact-version "pins".
 *
 * A `PackageReference` (or `PackageVersion` under CPM) whose version is written
 * with NuGet's exact-version syntax — `[1.2.3]` — is locked to precisely that
 * version: `dotnet restore` will not float it forward. The manager treats such a
 * reference as "pinned": it is held back from "Update All" and is not offered as
 * the default upgrade target. Pinning never suppresses vulnerability checks — a
 * pinned package that has a known advisory is still reported.
 *
 * https://learn.microsoft.com/nuget/concepts/package-versioning#version-ranges
 */

// [1.2.3] — a single version in square brackets, with no comma (that would be a
// range like [1.0,2.0)) and no interval left open.
const EXACT_PIN_RE = /^\[\s*([^,()[\]\s]+)\s*\]$/;

/** True when `raw` is exact-version syntax such as `[1.2.3]`. */
export function isExactVersionPin(raw: string | undefined | null): boolean {
  return typeof raw === "string" && EXACT_PIN_RE.test(raw.trim());
}

/** The version inside an exact pin (`[1.2.3]` → `1.2.3`), or `undefined`. */
export function exactPinnedVersion(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") return undefined;
  const m = EXACT_PIN_RE.exec(raw.trim());
  return m ? m[1] : undefined;
}

/** Strip an exact-pin wrapper: `[1.2.3]` → `1.2.3`. Any other string is returned trimmed and unchanged. */
export function stripVersionPin(raw: string): string {
  return exactPinnedVersion(raw) ?? raw.trim();
}

/** Wrap a plain version as an exact pin: `1.2.3` → `[1.2.3]`. Idempotent; empty input is passed through. */
export function toExactVersionPin(version: string): string {
  const v = version.trim();
  if (!v) return v;
  return isExactVersionPin(v) ? v : `[${stripVersionPin(v)}]`;
}
