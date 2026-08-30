import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  upsertPackageReference,
  removePackageReference,
  upsertPackageVersion,
  removePackageVersion
} from "../../src/projects/xmlEdit";

const classic = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Newtonsoft.Json" Version="13.0.1" />
  </ItemGroup>
</Project>
`;

test("updates an existing inline version", () => {
  const out = upsertPackageReference(classic, "Newtonsoft.Json", "13.0.3");
  assert.match(out, /Newtonsoft\.Json" Version="13\.0\.3"/);
  assert.doesNotMatch(out, /13\.0\.1/);
});

test("adds a new reference into the existing ItemGroup preserving indent", () => {
  const out = upsertPackageReference(classic, "Serilog", "3.1.1");
  assert.match(out, /\n    <PackageReference Include="Serilog" Version="3\.1\.1" \/>\n/);
  assert.match(out, /Newtonsoft\.Json/);
});

test("adds an ItemGroup when none has a PackageReference", () => {
  const bare = `<Project Sdk="Microsoft.NET.Sdk">\n  <PropertyGroup>\n    <TargetFramework>net8.0</TargetFramework>\n  </PropertyGroup>\n</Project>\n`;
  const out = upsertPackageReference(bare, "Serilog", "3.1.1");
  assert.match(out, /<ItemGroup>\s*<PackageReference Include="Serilog" Version="3\.1\.1" \/>\s*<\/ItemGroup>/);
});

test("removes a reference and drops the emptied ItemGroup", () => {
  const out = removePackageReference(classic, "Newtonsoft.Json");
  assert.doesNotMatch(out, /PackageReference/);
  assert.doesNotMatch(out, /<ItemGroup>\s*<\/ItemGroup>/);
});

test("converts child-element version to bare reference for CPM", () => {
  const child = `<Project>\n  <ItemGroup>\n    <PackageReference Include="Foo">\n      <Version>1.2.3</Version>\n    </PackageReference>\n  </ItemGroup>\n</Project>\n`;
  const out = upsertPackageReference(child, "Foo", undefined);
  assert.match(out, /<PackageReference Include="Foo" \/>/);
  assert.doesNotMatch(out, /<Version>/);
});

test("pins and unpins an inline version (exact-version syntax)", () => {
  const pinned = upsertPackageReference(classic, "Newtonsoft.Json", "[13.0.1]");
  assert.match(pinned, /Newtonsoft\.Json" Version="\[13\.0\.1\]"/);
  const unpinned = upsertPackageReference(pinned, "Newtonsoft.Json", "13.0.1");
  assert.match(unpinned, /Newtonsoft\.Json" Version="13\.0\.1"/);
  assert.doesNotMatch(unpinned, /\[13\.0\.1\]/);
});

test("preserves CRLF line endings", () => {
  const crlf = classic.replace(/\n/g, "\r\n");
  const out = upsertPackageReference(crlf, "Serilog", "3.1.1");
  assert.ok(out.includes("\r\n"));
  assert.doesNotMatch(out, /[^\r]\n/);
});

const props = `<Project>
  <PropertyGroup>
    <ManagePackageVersionsCentrally>true</ManagePackageVersionsCentrally>
  </PropertyGroup>
  <ItemGroup>
    <PackageVersion Include="Newtonsoft.Json" Version="13.0.1" />
  </ItemGroup>
</Project>
`;

test("upsertPackageVersion updates and inserts", () => {
  const bumped = upsertPackageVersion(props, "Newtonsoft.Json", "13.0.3");
  assert.match(bumped, /Newtonsoft\.Json" Version="13\.0\.3"/);
  const added = upsertPackageVersion(props, "Serilog", "3.1.1");
  assert.match(added, /<PackageVersion Include="Serilog" Version="3\.1\.1" \/>/);
});

test("removePackageVersion drops the item", () => {
  const out = removePackageVersion(props, "Newtonsoft.Json");
  assert.doesNotMatch(out, /<PackageVersion/);
});
