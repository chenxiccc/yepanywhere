import assert from "node:assert/strict";
import test from "node:test";
import { selectBundledYaVersion } from "./runtime-manifest.mjs";

test("the bundled YA version prefers the exact git build description", () => {
  assert.equal(
    selectBundledYaVersion("v0.7.0-204-g02856e2c", "0.7.0"),
    "v0.7.0-204-g02856e2c",
  );
});

test("the package version is only a fallback without git metadata", () => {
  assert.equal(selectBundledYaVersion("unknown", "0.7.0"), "0.7.0");
  assert.equal(selectBundledYaVersion("", ""), "unknown");
});
