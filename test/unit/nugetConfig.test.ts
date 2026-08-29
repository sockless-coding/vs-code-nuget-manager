import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseNuGetConfig, mergeConfigs, isV3Feed } from "../../src/nuget/nugetConfig";

const machine = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json" protocolVersion="3" />
  </packageSources>
</configuration>`;

const repo = `<?xml version="1.0" encoding="utf-8"?>
<configuration>
  <packageSources>
    <add key="contoso" value="https://pkgs.contoso.com/v3/index.json" />
  </packageSources>
  <disabledPackageSources>
    <add key="nuget.org" value="true" />
  </disabledPackageSources>
  <packageSourceCredentials>
    <contoso>
      <add key="Username" value="build" />
      <add key="ClearTextPassword" value="s3cret" />
    </contoso>
  </packageSourceCredentials>
</configuration>`;

test("parses sources, disabled flags and credentials", () => {
  const p = parseNuGetConfig(repo);
  assert.equal(p.sources.length, 1);
  assert.equal(p.sources[0].key, "contoso");
  assert.deepEqual(p.disabledSources, ["nuget.org"]);
  assert.equal(p.credentials[0].sourceKey, "contoso");
  assert.equal(p.credentials[0].clearTextPassword, "s3cret");
});

test("merge keeps nearest wins and applies disabled sources", () => {
  const feeds = mergeConfigs([parseNuGetConfig(machine), parseNuGetConfig(repo)]);
  const byName = Object.fromEntries(feeds.map((f) => [f.name, f]));
  assert.equal(feeds.length, 2);
  assert.equal(byName["nuget.org"].enabled, false);
  assert.equal(byName["contoso"].enabled, true);
  assert.equal(byName["contoso"].username, "build");
});

test("clear drops lower-priority sources", () => {
  const clearing = `<?xml version="1.0"?><configuration><packageSources><clear /><add key="only" value="https://only/v3/index.json" /></packageSources></configuration>`;
  const feeds = mergeConfigs([parseNuGetConfig(machine), parseNuGetConfig(clearing)]);
  assert.deepEqual(feeds.map((f) => f.name), ["only"]);
});

test("decodes encoded credential element names", () => {
  const xml = `<?xml version="1.0"?><configuration><packageSourceCredentials><Contoso_x0020_Feed><add key="Username" value="u" /><add key="ClearTextPassword" value="p" /></Contoso_x0020_Feed></packageSourceCredentials></configuration>`;
  const p = parseNuGetConfig(xml);
  assert.equal(p.credentials[0].sourceKey, "Contoso Feed");
});

test("isV3Feed detects index.json and protocolVersion", () => {
  assert.equal(isV3Feed({ url: "https://api.nuget.org/v3/index.json" }), true);
  assert.equal(isV3Feed({ url: "https://legacy/nuget", protocolVersion: "3" }), true);
  assert.equal(isV3Feed({ url: "https://legacy/nuget/v2" }), false);
});
