import * as path from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import {
  isPathInsideDirectory,
  isSupportedAbsoluteLocalPath,
  LOCAL_MEDIA_EXTENSIONS,
  createLocalResourcePathPolicy,
} from "../../src/routes/local-resource-policy.js";

describe("local resource path policy", () => {
  it("classifies local absolute path syntax by server platform", () => {
    expect(isSupportedAbsoluteLocalPath("/tmp/probe.json", "linux")).toBe(true);
    expect(
      isSupportedAbsoluteLocalPath("//host/share/probe.json", "linux"),
    ).toBe(false);
    expect(isSupportedAbsoluteLocalPath("C:/tmp/probe.json", "linux")).toBe(
      false,
    );
    expect(isSupportedAbsoluteLocalPath("C:/tmp/probe.json", "win32")).toBe(
      true,
    );
    expect(isSupportedAbsoluteLocalPath("C:\\tmp\\probe.json", "win32")).toBe(
      true,
    );
    expect(isSupportedAbsoluteLocalPath("/C:/tmp/probe.json", "win32")).toBe(
      true,
    );
    expect(isSupportedAbsoluteLocalPath("tmp/probe.json", "win32")).toBe(false);
  });

  it("keeps resolved files inside allowed directories", () => {
    const root = path.resolve("/tmp/yep-local-resource-root");
    const child = path.join(root, "nested", "probe.json");
    const sibling = path.join(`${root}-sibling`, "probe.json");

    expect(isPathInsideDirectory(child, root)).toBe(true);
    expect(isPathInsideDirectory(sibling, root)).toBe(false);
    expect(isPathInsideDirectory(root, root)).toBe(false);
  });

  it("shares media extension policy with both local resource routes", () => {
    expect(LOCAL_MEDIA_EXTENSIONS.has(".png")).toBe(true);
    expect(LOCAL_MEDIA_EXTENSIONS.has(".ogv")).toBe(true);
    expect(LOCAL_MEDIA_EXTENSIONS.has(".json")).toBe(false);
  });

  it("batch-resolves only regular files inside the allow-set", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "ya-resource-policy-"));
    const outside = await mkdtemp(path.join(tmpdir(), "ya-resource-outside-"));
    try {
      const allowedFile = path.join(root, "allowed.md");
      const outsideFile = path.join(outside, "outside.md");
      await writeFile(allowedFile, "allowed\n");
      await writeFile(outsideFile, "outside\n");
      const policy = createLocalResourcePathPolicy({ allowedPaths: [root] });

      expect(
        policy.findKnownAllowedFilePaths([allowedFile, outsideFile]),
      ).toEqual(new Set());
      expect(
        await policy.findAllowedFilePaths([
          allowedFile,
          outsideFile,
          path.join(root, "missing.md"),
          "/x",
        ]),
      ).toEqual(new Set([allowedFile]));
      expect(
        policy.findKnownAllowedFilePaths([allowedFile, outsideFile]),
      ).toEqual(new Set([allowedFile]));
    } finally {
      await Promise.all([
        rm(root, { recursive: true }),
        rm(outside, { recursive: true }),
      ]);
    }
  });
});
