import { strict as assert } from "node:assert";
import { test } from "node:test";
import { NuGetVersion, sortVersionsDescending, maxVersion } from "../../src/nuget/NuGetVersion";

function cmp(a: string, b: string): number {
  return NuGetVersion.compare(NuGetVersion.parse(a), NuGetVersion.parse(b));
}

test("parses four-part versions", () => {
  const v = NuGetVersion.parse("1.2.3.4");
  assert.equal(v.major, 1);
  assert.equal(v.minor, 2);
  assert.equal(v.patch, 3);
  assert.equal(v.revision, 4);
  assert.equal(v.isPrerelease, false);
});

test("missing segments are zero", () => {
  assert.equal(cmp("1.0", "1.0.0"), 0);
  assert.equal(cmp("1.0", "1.0.0.0"), 0);
  assert.equal(cmp("1", "1.0.0"), 0);
});

test("numeric precedence", () => {
  assert.ok(cmp("2.0.0", "1.0.0") > 0);
  assert.ok(cmp("1.10.0", "1.9.0") > 0);
  assert.ok(cmp("1.0.0.1", "1.0.0") > 0);
  assert.ok(cmp("9.0.0", "10.0.0") < 0);
});

test("stable outranks prerelease", () => {
  assert.ok(cmp("1.0.0", "1.0.0-rc") > 0);
  assert.ok(cmp("1.0.0-beta", "1.0.0") < 0);
  assert.ok(cmp("2.0.0", "2.0.0-beta") > 0);
});

test("prerelease label ordering", () => {
  const ordered = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0"
  ];
  for (let i = 0; i < ordered.length - 1; i++) {
    assert.ok(cmp(ordered[i], ordered[i + 1]) < 0, `${ordered[i]} should be < ${ordered[i + 1]}`);
  }
});

test("prerelease labels are case-insensitive", () => {
  assert.equal(cmp("1.0.0-Beta", "1.0.0-beta"), 0);
  assert.equal(cmp("1.0.0-RC.1", "1.0.0-rc.1"), 0);
});

test("build metadata is ignored", () => {
  assert.equal(cmp("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(cmp("1.0.0+abc", "1.0.0"), 0);
});

test("sortVersionsDescending puts newest first and prereleases in place", () => {
  const input = ["1.0.0", "2.0.0-beta", "1.0.0-rc.1", "10.0.0", "2.0.0", "9.0.1"];
  assert.deepEqual(sortVersionsDescending(input), [
    "10.0.0",
    "9.0.1",
    "2.0.0",
    "2.0.0-beta",
    "1.0.0",
    "1.0.0-rc.1"
  ]);
});

test("sortVersionsDescending keeps unparseable entries last", () => {
  const input = ["1.0.0", "not-a-version", "2.0.0"];
  assert.deepEqual(sortVersionsDescending(input), ["2.0.0", "1.0.0", "not-a-version"]);
});

test("maxVersion respects prerelease flag", () => {
  const input = ["1.0.0", "1.1.0-beta", "0.9.0"];
  assert.equal(maxVersion(input, false), "1.0.0");
  assert.equal(maxVersion(input, true), "1.1.0-beta");
});

test("tryParse rejects garbage", () => {
  assert.equal(NuGetVersion.tryParse("abc"), undefined);
  assert.equal(NuGetVersion.tryParse(""), undefined);
  assert.equal(NuGetVersion.tryParse("1.2.3.4.5"), undefined);
});
