/**
 * Format-preserving edits to MSBuild project / props files.
 *
 * These operate on raw text with targeted regex splices rather than re-serializing
 * a parsed tree, so existing indentation, comments and attribute ordering survive.
 * Used by `mutations.ts` on the no-SDK fallback path. Pure — no VS Code imports —
 * so they are unit tested directly.
 */

const EOL_RE = /\r\n|\n|\r/;

function detectEol(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/** Indentation of one nesting level, inferred from the file. */
function baseIndent(text: string): string {
  const m = text.match(/\n([ \t]+)<(PropertyGroup|ItemGroup)\b/);
  return m ? m[1] : "  ";
}

/** Indentation used for `<Package*>` items, inferred from an existing item. */
function itemIndent(text: string): string {
  const m = text.match(/\n([ \t]+)<Package(Reference|Version)\b/);
  if (m) return m[1];
  return baseIndent(text) + baseIndent(text);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Add or update a `<PackageReference Include="id" />`. Pass `version` to set an
 * inline `Version` attribute, or `undefined` for a bare reference (CPM style).
 */
export function upsertPackageReference(text: string, id: string, version: string | undefined): string {
  const escaped = escapeRe(id);

  // Existing reference with a child <Version> element -> normalise to one line.
  const childRe = new RegExp(
    `<PackageReference\\s+[^>]*?\\bInclude\\s*=\\s*"${escaped}"[^>]*>\\s*<Version>[^<]*</Version>\\s*</PackageReference>`,
    "i"
  );
  if (childRe.test(text)) {
    return text.replace(
      childRe,
      version === undefined
        ? `<PackageReference Include="${id}" />`
        : `<PackageReference Include="${id}" Version="${version}" />`
    );
  }

  // Existing self-closing reference with (maybe) an inline Version attribute.
  const attrRe = new RegExp(`(<PackageReference\\s+[^>]*?\\bInclude\\s*=\\s*"${escaped}"[^>]*?)(\\s*/>)`, "i");
  const existing = text.match(attrRe);
  if (existing) {
    let tag = existing[1];
    if (version === undefined) {
      tag = tag.replace(/\s+Version\s*=\s*"[^"]*"/i, "");
    } else if (/\bVersion\s*=\s*"/i.test(tag)) {
      tag = tag.replace(/(\bVersion\s*=\s*")[^"]*(")/i, `$1${version}$2`);
    } else {
      tag = `${tag} Version="${version}"`;
    }
    return text.replace(attrRe, `${tag}${existing[2]}`);
  }

  const indent = itemIndent(text);
  const newItem =
    version === undefined
      ? `${indent}<PackageReference Include="${id}" />`
      : `${indent}<PackageReference Include="${id}" Version="${version}" />`;
  return insertItem(text, "PackageReference", newItem);
}

export function removePackageReference(text: string, id: string): string {
  const escaped = escapeRe(id);
  const selfClosing = new RegExp(
    `[ \\t]*<PackageReference\\s+[^>]*?\\bInclude\\s*=\\s*"${escaped}"[^>]*/>\\s*(?:${EOL_RE.source})?`,
    "i"
  );
  const withChildren = new RegExp(
    `[ \\t]*<PackageReference\\s+[^>]*?\\bInclude\\s*=\\s*"${escaped}"[^>]*>[\\s\\S]*?</PackageReference>\\s*(?:${EOL_RE.source})?`,
    "i"
  );
  let out = text.replace(withChildren, "");
  out = out.replace(selfClosing, "");
  return dropEmptyItemGroups(out);
}

export function upsertPackageVersion(text: string, id: string, version: string): string {
  const escaped = escapeRe(id);
  const re = new RegExp(
    `(<PackageVersion\\s+[^>]*?\\bInclude\\s*=\\s*"${escaped}"[^>]*?\\bVersion\\s*=\\s*")[^"]*(")`,
    "i"
  );
  if (re.test(text)) {
    return text.replace(re, `$1${version}$2`);
  }
  const newItem = `${itemIndent(text)}<PackageVersion Include="${id}" Version="${version}" />`;
  return insertItem(text, "PackageVersion", newItem);
}

export function removePackageVersion(text: string, id: string): string {
  const escaped = escapeRe(id);
  const re = new RegExp(
    `[ \\t]*<PackageVersion\\s+[^>]*?\\bInclude\\s*=\\s*"${escaped}"[^>]*/>\\s*(?:${EOL_RE.source})?`,
    "i"
  );
  return dropEmptyItemGroups(text.replace(re, ""));
}

/**
 * Insert `newItem` just before the closing tag of the first `<ItemGroup>` that
 * already contains a `<${childTag} ...>`; otherwise create a new `<ItemGroup>`
 * before `</Project>`.
 */
function insertItem(text: string, childTag: string, newItem: string): string {
  const eol = detectEol(text);
  const groupRe = new RegExp(`([ \\t]*)<ItemGroup\\b[^>]*>[\\s\\S]*?<${childTag}\\b[\\s\\S]*?</ItemGroup>`, "i");
  const g = text.match(groupRe);
  if (g && g.index !== undefined) {
    const closeIdx = g.index + g[0].lastIndexOf("</ItemGroup>");
    const before = text.slice(0, closeIdx).replace(/[ \t]*$/, "");
    const after = text.slice(closeIdx);
    return `${before}${newItem}${eol}${g[1]}${after}`;
  }

  const indent = baseIndent(text);
  const block = `${eol}${indent}<ItemGroup>${eol}${newItem}${eol}${indent}</ItemGroup>${eol}`;
  const closeRe = /([ \t]*)<\/Project>\s*$/;
  if (closeRe.test(text)) {
    return text.replace(closeRe, `${block}$1</Project>${eol}`);
  }
  return `${text}${block}`;
}

function dropEmptyItemGroups(text: string): string {
  return text.replace(/[ \t]*<ItemGroup\b[^>]*>\s*<\/ItemGroup>\s*(?:\r\n|\n|\r)?/gi, "");
}
