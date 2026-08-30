import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isExactVersionPin,
  exactPinnedVersion,
  stripVersionPin,
  toExactVersionPin
} from "../../src/nuget/versionRange";

test("recognises exact-version pins", () => {
  assert.equal(isExactVersionPin("[1.2.3]"), true);
  assert.equal(isExactVersionPin("  [1.2.3] "), true);
  assert.equal(isExactVersionPin("[1.2.3-beta.1]"), true);
  assert.equal(isExactVersionPin("[1.2.3, ]"), false);
  assert.equal(isExactVersionPin("[1.0,2.0)"), false);
  assert.equal(isExactVersionPin("(1.0,2.0)"), false);
  assert.equal(isExactVersionPin("1.2.3"), false);
  assert.equal(isExactVersionPin(""), false);
  assert.equal(isExactVersionPin(undefined), false);
});

test("extracts the pinned version", () => {
  assert.equal(exactPinnedVersion("[1.2.3]"), "1.2.3");
  assert.equal(exactPinnedVersion("1.2.3"), undefined);
  assert.equal(exactPinnedVersion("[1.0,2.0)"), undefined);
});

test("stripVersionPin unwraps only exact pins", () => {
  assert.equal(stripVersionPin("[1.2.3]"), "1.2.3");
  assert.equal(stripVersionPin(" 1.2.3 "), "1.2.3");
  assert.equal(stripVersionPin("[1.0,2.0)"), "[1.0,2.0)");
});

test("toExactVersionPin wraps and is idempotent", () => {
  assert.equal(toExactVersionPin("1.2.3"), "[1.2.3]");
  assert.equal(toExactVersionPin("[1.2.3]"), "[1.2.3]");
  assert.equal(toExactVersionPin(" 1.2.3 "), "[1.2.3]");
  assert.equal(toExactVersionPin(""), "");
});
