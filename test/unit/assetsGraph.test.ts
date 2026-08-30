import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildGraph, mergeGraphs } from "../../src/projects/assetsGraph";

const assets = {
  version: 3,
  targets: {
    "net8.0": {
      "Serilog/3.1.1": {
        type: "package",
        dependencies: { "Serilog.Sinks.Console": "5.0.0" }
      },
      "Serilog.Sinks.Console/5.0.0": {
        type: "package",
        dependencies: { Serilog: "3.1.1" }
      },
      "Newtonsoft.Json/12.0.3": { type: "package" }
    }
  },
  projectFileDependencyGroups: {
    "net8.0": ["Serilog >= 3.1.1", "Newtonsoft.Json >= 12.0.3"]
  },
  logs: [
    {
      code: "NU1903",
      level: "Warning",
      message:
        "Package 'Newtonsoft.Json' 12.0.3 has a known high severity vulnerability, https://github.com/advisories/GHSA-5crp-9r3c-p9vr",
      libraryId: "Newtonsoft.Json"
    }
  ]
};

test("builds parent -> child and reverse edges", () => {
  const g = buildGraph(assets);
  assert.deepEqual([...(g.dependencies.get("serilog") ?? [])], ["serilog.sinks.console"]);
  assert.deepEqual([...(g.dependents.get("serilog.sinks.console") ?? [])], ["serilog"]);
});

test("does not create a self edge from a dependency cycle", () => {
  const g = buildGraph(assets);
  assert.ok(!g.dependencies.get("serilog")?.has("serilog"));
});

test("reads top-level packages from projectFileDependencyGroups", () => {
  const g = buildGraph(assets);
  assert.ok(g.topLevel.has("serilog"));
  assert.ok(g.topLevel.has("newtonsoft.json"));
  assert.ok(!g.topLevel.has("serilog.sinks.console"));
});

test("parses audit warnings into advisories keyed by package", () => {
  const g = buildGraph(assets);
  const adv = g.vulnerabilities.get("newtonsoft.json");
  assert.equal(adv?.length, 1);
  assert.equal(adv?.[0].severity, 2);
  assert.match(adv?.[0].advisoryUrl ?? "", /GHSA-5crp-9r3c-p9vr/);
});

test("preserves original casing in displayName", () => {
  const g = buildGraph(assets);
  assert.equal(g.displayName.get("serilog.sinks.console"), "Serilog.Sinks.Console");
});

test("mergeGraphs unions edges and advisories", () => {
  const a = buildGraph(assets);
  const b = buildGraph({
    targets: { "net8.0": { "A/1.0.0": { type: "package", dependencies: { B: "1.0.0" } } } },
    projectFileDependencyGroups: { "net8.0": ["A >= 1.0.0"] }
  });
  const merged = mergeGraphs([a, b, undefined]);
  assert.ok(merged.dependents.get("b")?.has("a"));
  assert.ok(merged.dependents.get("serilog.sinks.console")?.has("serilog"));
  assert.equal(merged.vulnerabilities.get("newtonsoft.json")?.length, 1);
});

test("tolerates a malformed document", () => {
  const g = buildGraph("not an object");
  assert.equal(g.dependencies.size, 0);
  assert.equal(g.topLevel.size, 0);
});
