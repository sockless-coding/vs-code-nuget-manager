import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  resolveCentralVersions,
  pickHighestVersion,
  commonAncestor,
  buildPropsFile,
  parsePackageVersionItems,
  mergeExistingVersions
} from "../../src/projects/cpmPlan";

test("pickHighestVersion returns the highest, keeping the original text", () => {
  assert.equal(pickHighestVersion(["1.2.3", "1.10.0", "1.9.9"]), "1.10.0");
  assert.equal(pickHighestVersion(["13.0.1", "[13.0.3]"]), "[13.0.3]");
  assert.equal(pickHighestVersion(["2.0.0-beta", "2.0.0"]), "2.0.0");
});

test("resolveCentralVersions consolidates to the highest and reports bumps", () => {
  const { versions, bumps } = resolveCentralVersions([
    { path: "a", name: "A", refs: [{ id: "Serilog", version: "3.0.0" }, { id: "Polly", version: "8.2.0" }] },
    { path: "b", name: "B", refs: [{ id: "Serilog", version: "3.1.1" }] }
  ]);

  assert.deepEqual(
    versions,
    [
      { id: "Polly", version: "8.2.0" },
      { id: "Serilog", version: "3.1.1" }
    ]
  );
  assert.deepEqual(bumps, [{ project: "A", packageId: "Serilog", from: "3.0.0", to: "3.1.1" }]);
});

test("resolveCentralVersions is case-insensitive on package id and skips empty versions", () => {
  const { versions, bumps } = resolveCentralVersions([
    { path: "a", name: "A", refs: [{ id: "Newtonsoft.Json", version: "13.0.1" }] },
    { path: "b", name: "B", refs: [{ id: "newtonsoft.json", version: "13.0.3" }, { id: "Bare", version: "" }] }
  ]);

  assert.equal(versions.length, 1);
  assert.equal(versions[0].version, "13.0.3");
  assert.deepEqual(bumps, [
    { project: "A", packageId: "Newtonsoft.Json", from: "13.0.1", to: "13.0.3" }
  ]);
});

test("resolveCentralVersions does not report a bump when only the pin bracket differs", () => {
  const { bumps } = resolveCentralVersions([
    { path: "a", name: "A", refs: [{ id: "X", version: "1.0.0" }] },
    { path: "b", name: "B", refs: [{ id: "X", version: "[1.0.0]" }] }
  ]);
  assert.deepEqual(bumps, []);
});

test("commonAncestor finds the shared directory prefix", () => {
  assert.equal(commonAncestor(["/repo/src/A", "/repo/src/B"], "/"), "/repo/src");
  assert.equal(commonAncestor(["/repo/src/A", "/repo/test/B"], "/"), "/repo");
  assert.equal(commonAncestor(["/repo/A"], "/"), "/repo/A");
});

test("buildPropsFile emits a CPM-enabled props file", () => {
  const out = buildPropsFile([{ id: "Serilog", version: "3.1.1" }]);
  assert.match(out, /<ManagePackageVersionsCentrally>true<\/ManagePackageVersionsCentrally>/);
  assert.match(out, /<PackageVersion Include="Serilog" Version="3\.1\.1" \/>/);
});

test("parsePackageVersionItems reads existing central versions", () => {
  const text = `<Project>\n  <ItemGroup>\n    <PackageVersion Include="Serilog" Version="3.1.1" />\n    <PackageVersion Include="Polly" Version="8.2.0" />\n  </ItemGroup>\n</Project>`;
  assert.deepEqual(parsePackageVersionItems(text), [
    { id: "Serilog", version: "3.1.1" },
    { id: "Polly", version: "8.2.0" }
  ]);
});

test("mergeExistingVersions never downgrades an already-central package", () => {
  const merged = mergeExistingVersions(
    [{ id: "Serilog", version: "3.0.0" }, { id: "New", version: "1.0.0" }],
    [{ id: "Serilog", version: "3.1.1" }, { id: "Old", version: "2.0.0" }]
  );
  assert.deepEqual(merged, [
    { id: "New", version: "1.0.0" },
    { id: "Old", version: "2.0.0" },
    { id: "Serilog", version: "3.1.1" }
  ]);
});
