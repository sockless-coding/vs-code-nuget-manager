/**
 * NuGet version parsing and comparison.
 *
 * NuGet does not use plain SemVer: versions may have a fourth "revision" segment
 * (`1.2.3.4`), and the `semver` npm package rejects those. This implements the
 * ordering rules documented at
 * https://learn.microsoft.com/nuget/concepts/package-versioning
 *
 * Rules:
 *  - Numeric parts (major.minor.patch.revision) compared left to right; a missing
 *    segment is treated as 0, so `1.0` == `1.0.0` == `1.0.0.0`.
 *  - A version WITH a prerelease label is lower than the same version WITHOUT one
 *    (`1.0.0-rc` < `1.0.0`).
 *  - Prerelease labels are split on `.` and compared segment by segment:
 *      - all-digit segments compare numerically and rank below non-numeric segments;
 *      - other segments compare case-insensitively (ASCII ordinal);
 *      - if all compared segments are equal, the label with more segments is higher.
 *  - Build metadata (`+abc`) is ignored for ordering.
 */

export class NuGetVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly revision: number;
  /** Original prerelease label without the leading '-', or '' when stable. */
  readonly prerelease: string;
  readonly metadata: string;
  readonly original: string;

  private constructor(
    major: number,
    minor: number,
    patch: number,
    revision: number,
    prerelease: string,
    metadata: string,
    original: string
  ) {
    this.major = major;
    this.minor = minor;
    this.patch = patch;
    this.revision = revision;
    this.prerelease = prerelease;
    this.metadata = metadata;
    this.original = original;
  }

  get isPrerelease(): boolean {
    return this.prerelease.length > 0;
  }

  toString(): string {
    return this.original;
  }

  /** Parse a version string, returning `undefined` when it is not a valid NuGet version. */
  static tryParse(input: string): NuGetVersion | undefined {
    if (typeof input !== "string") {
      return undefined;
    }
    const value = input.trim();
    // major(.minor(.patch(.revision)))(-prerelease)(+metadata)
    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z-.]+))?(?:\+([0-9A-Za-z-.]+))?$/.exec(
      value
    );
    if (!match) {
      return undefined;
    }
    const [, maj, min, pat, rev, pre, meta] = match;
    return new NuGetVersion(
      Number(maj),
      min !== undefined ? Number(min) : 0,
      pat !== undefined ? Number(pat) : 0,
      rev !== undefined ? Number(rev) : 0,
      pre ?? "",
      meta ?? "",
      value
    );
  }

  static parse(input: string): NuGetVersion {
    const parsed = NuGetVersion.tryParse(input);
    if (!parsed) {
      throw new Error(`Invalid NuGet version: "${input}"`);
    }
    return parsed;
  }

  /** Negative when a < b, positive when a > b, 0 when equal in precedence. */
  static compare(a: NuGetVersion, b: NuGetVersion): number {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    if (a.revision !== b.revision) return a.revision - b.revision;

    // Stable outranks prerelease.
    if (!a.isPrerelease && !b.isPrerelease) return 0;
    if (!a.isPrerelease) return 1;
    if (!b.isPrerelease) return -1;

    return comparePrerelease(a.prerelease, b.prerelease);
  }

  static equals(a: NuGetVersion, b: NuGetVersion): boolean {
    return NuGetVersion.compare(a, b) === 0;
  }
}

function comparePrerelease(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const x = as[i];
    const y = bs[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;

    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const d = Number(x) - Number(y);
      if (d !== 0) return Math.sign(d);
    } else if (xNum) {
      return -1; // numeric segments rank below alphanumeric
    } else if (yNum) {
      return 1;
    } else {
      const xl = x.toLowerCase();
      const yl = y.toLowerCase();
      if (xl < yl) return -1;
      if (xl > yl) return 1;
    }
  }
  return 0;
}

/**
 * Sort an array of version strings newest-first (descending precedence).
 * Unparseable strings are pushed to the end, preserving their relative order.
 */
export function sortVersionsDescending(versions: string[]): string[] {
  const decorated = versions.map((v, index) => ({ v, index, parsed: NuGetVersion.tryParse(v) }));
  decorated.sort((l, r) => {
    if (l.parsed && r.parsed) {
      const c = NuGetVersion.compare(r.parsed, l.parsed);
      return c !== 0 ? c : l.index - r.index;
    }
    if (l.parsed) return -1;
    if (r.parsed) return 1;
    return l.index - r.index;
  });
  return decorated.map((d) => d.v);
}

/** Pick the highest version from a list, optionally excluding prereleases. */
export function maxVersion(versions: string[], includePrerelease: boolean): string | undefined {
  let best: NuGetVersion | undefined;
  for (const raw of versions) {
    const parsed = NuGetVersion.tryParse(raw);
    if (!parsed) continue;
    if (parsed.isPrerelease && !includePrerelease) continue;
    if (!best || NuGetVersion.compare(parsed, best) > 0) {
      best = parsed;
    }
  }
  return best?.original;
}
