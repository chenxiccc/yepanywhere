import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  compareCodexCliVersions,
  detectCodexCli,
  findCodexCliPath,
  getCodexCliVersion,
  normalizeCodexCliVersion,
} from "../../src/sdk/cli-detection.js";

const tempDirs: string[] = [];
const originalPath = process.env.PATH;

afterEach(() => {
  process.env.PATH = originalPath;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function createFakeCodex(dir: string, version: string): string {
  if (process.platform === "win32") {
    const path = join(dir, "codex.cmd");
    writeFileSync(path, `@echo off\r\necho codex-cli ${version}\r\n`, "utf-8");
    return path;
  }

  const path = join(dir, "codex");
  writeFileSync(path, `#!/bin/sh\necho codex-cli ${version}\n`, "utf-8");
  chmodSync(path, 0o755);
  return path;
}

function prependPath(...dirs: string[]): void {
  process.env.PATH = [dirs.join(delimiter), originalPath ?? ""]
    .filter(Boolean)
    .join(delimiter);
}

describe("Codex CLI detection", () => {
  it("normalizes and compares Codex CLI semver output", () => {
    expect(normalizeCodexCliVersion("codex-cli 0.144.1")).toBe("0.144.1");
    expect(normalizeCodexCliVersion("v0.144.1-beta.1")).toBe("0.144.1-beta.1");
    expect(normalizeCodexCliVersion("no version")).toBeNull();

    expect(compareCodexCliVersions("0.144.1", "0.142.0")).toBeGreaterThan(0);
    expect(compareCodexCliVersions("0.144.1-beta.1", "0.144.1")).toBeLessThan(
      0,
    );
  });

  it("probes the version of a runnable codex candidate", async () => {
    const dir = makeTempDir("codex-version-");
    const codexPath = createFakeCodex(dir, "99.5.0");

    await expect(getCodexCliVersion(codexPath)).resolves.toBe(
      "codex-cli 99.5.0",
    );
  });

  it("keeps an explicit codex path authoritative", async () => {
    const explicitDir = makeTempDir("codex-explicit-");
    const pathDir = makeTempDir("codex-path-");
    const explicitCodex = createFakeCodex(explicitDir, "1.0.0");
    createFakeCodex(pathDir, "99.9.0");
    prependPath(pathDir);

    await expect(findCodexCliPath(explicitCodex)).resolves.toBe(explicitCodex);
    await expect(detectCodexCli(explicitCodex)).resolves.toMatchObject({
      found: true,
      path: explicitCodex,
      version: "codex-cli 1.0.0",
    });
  });

  it("auto-detects the highest version rather than the first PATH hit", async () => {
    const oldDir = makeTempDir("codex-old-");
    const newDir = makeTempDir("codex-new-");
    createFakeCodex(oldDir, "99.1.0");
    const newerCodex = createFakeCodex(newDir, "99.2.0");
    prependPath(oldDir, newDir);

    await expect(findCodexCliPath()).resolves.toBe(newerCodex);
    await expect(detectCodexCli()).resolves.toMatchObject({
      found: true,
      path: newerCodex,
      version: "codex-cli 99.2.0",
    });
  });
});
