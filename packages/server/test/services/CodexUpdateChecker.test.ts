import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CodexUpdateChecker,
  __testing__,
} from "../../src/services/CodexUpdateChecker.js";

const { normalizeVersion, compareVersions } = __testing__;
const { extractNpmGlobalPackageName, inferManualInstallCommand } = __testing__;
const { resolveNpmPrefixShimPackage } = __testing__;

const immediateInstallationCoordinator = {
  async withReadLease<T>(
    _family: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return operation();
  },
  async runExclusiveUpdate<T>(
    family: string,
    operation: (context: { family: string; operationId: string }) => Promise<T>,
  ): Promise<T> {
    return operation({ family, operationId: "test-update" });
  },
};

describe("CodexUpdateChecker version helpers", () => {
  it("extracts semver from typical CLI output", () => {
    expect(normalizeVersion("codex 0.4.3")).toBe("0.4.3");
    expect(normalizeVersion("v0.4.3")).toBe("0.4.3");
    expect(normalizeVersion("0.4.3-rc.1")).toBe("0.4.3-rc.1");
    expect(normalizeVersion("")).toBeNull();
    expect(normalizeVersion(undefined)).toBeNull();
    expect(normalizeVersion("not-a-version")).toBeNull();
  });

  it("compares versions by precedence", () => {
    expect(compareVersions("0.4.3", "0.4.3")).toBe(0);
    expect(compareVersions("0.4.3", "0.4.4")).toBeLessThan(0);
    expect(compareVersions("0.5.0", "0.4.9")).toBeGreaterThan(0);
    expect(compareVersions("1.0.0", "0.9.9")).toBeGreaterThan(0);
  });

  it("treats prerelease as lower than release", () => {
    expect(compareVersions("0.4.3-rc.1", "0.4.3")).toBeLessThan(0);
    expect(compareVersions("0.4.3", "0.4.3-rc.1")).toBeGreaterThan(0);
    expect(compareVersions("0.4.3-rc.1", "0.4.3-rc.2")).toBeLessThan(0);
  });

  it("infers manual install command from homebrew and cargo paths", () => {
    expect(
      inferManualInstallCommand("/opt/homebrew/Cellar/codex/0.4.3/bin/codex"),
    ).toBe("brew upgrade codex");
    expect(
      inferManualInstallCommand(
        "/usr/local/Cellar/codex/0.4.3/libexec/bin/codex",
      ),
    ).toBe("brew upgrade codex");
    expect(inferManualInstallCommand("/home/graehl/.cargo/bin/codex")).toBe(
      "cargo install --locked codex",
    );
    expect(inferManualInstallCommand("/opt/codex-bundle/codex")).toBeNull();
  });

  it("extracts npm package names from global node_modules paths", () => {
    expect(
      extractNpmGlobalPackageName(
        "/usr/local/lib/node_modules/@openai/codex/bin/codex.js",
        "/usr/local/lib/node_modules",
      ),
    ).toBe("@openai/codex");
    expect(
      extractNpmGlobalPackageName(
        "/usr/local/lib/node_modules/codex/bin/codex.js",
        "/usr/local/lib/node_modules",
      ),
    ).toBe("codex");
    expect(
      extractNpmGlobalPackageName(
        "/usr/local/bin/codex",
        "/usr/local/lib/node_modules",
      ),
    ).toBeNull();
  });
});

describe("npm prefix shim resolution", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Build the Windows npm-global layout: shims beside node_modules. */
  function makeNpmPrefix(): { prefix: string; root: string } {
    const prefix = mkdtempSync(path.join(tmpdir(), "ya-npm-prefix-"));
    tempDirs.push(prefix);
    const root = path.join(prefix, "node_modules");
    mkdirSync(path.join(root, "@openai", "codex", "bin"), { recursive: true });
    return { prefix, root };
  }

  const CMD_SHIM = [
    "@ECHO off",
    "SETLOCAL",
    'SET "NODE_EXE=node.exe"',
    '"%NODE_EXE%"  "%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
    "",
  ].join("\r\n");

  it("resolves the package behind a Windows cmd shim beside node_modules", async () => {
    const { prefix, root } = makeNpmPrefix();
    const shimPath = path.join(prefix, "codex.cmd");
    writeFileSync(shimPath, CMD_SHIM);

    await expect(resolveNpmPrefixShimPackage(shimPath, root)).resolves.toBe(
      "@openai/codex",
    );
  });

  it("resolves forward-slash sh/PowerShell shim references", async () => {
    const { prefix, root } = makeNpmPrefix();
    const shimPath = path.join(prefix, "codex");
    writeFileSync(
      shimPath,
      '#!/bin/sh\nexec node  "$basedir/node_modules/@openai/codex/bin/codex.js" "$@"\n',
    );

    await expect(resolveNpmPrefixShimPackage(shimPath, root)).resolves.toBe(
      "@openai/codex",
    );
  });

  it("rejects a shim naming a package absent from the npm root", async () => {
    const { prefix, root } = makeNpmPrefix();
    const shimPath = path.join(prefix, "other.cmd");
    writeFileSync(
      shimPath,
      '"%NODE_EXE%" "%~dp0\\node_modules\\missing-package\\bin\\cli.js" %*',
    );

    await expect(
      resolveNpmPrefixShimPackage(shimPath, root),
    ).resolves.toBeNull();
  });

  it("rejects executables that do not sit beside node_modules", async () => {
    const { prefix, root } = makeNpmPrefix();
    const elsewhere = path.join(prefix, "bin");
    mkdirSync(elsewhere);
    const shimPath = path.join(elsewhere, "codex.cmd");
    writeFileSync(shimPath, CMD_SHIM);

    await expect(
      resolveNpmPrefixShimPackage(shimPath, root),
    ).resolves.toBeNull();
  });

  it("rejects roots that are not a node_modules directory", async () => {
    const { prefix } = makeNpmPrefix();
    const shimPath = path.join(prefix, "codex.cmd");
    writeFileSync(shimPath, CMD_SHIM);

    await expect(
      resolveNpmPrefixShimPackage(shimPath, path.join(prefix, "lib")),
    ).resolves.toBeNull();
  });
});

describe("CodexUpdateChecker", () => {
  it("marks update available when installed < latest", async () => {
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({
        version: "codex 0.4.2",
        path: "/usr/local/bin/codex",
      }),
      fetchLatest: async () => ({
        tagName: "v0.4.3",
        htmlUrl: "https://github.com/openai/codex/releases/tag/v0.4.3",
      }),
      detectInstallMetadata: async () => ({
        installedPackage: "@openai/codex",
        updateMethod: "npm",
        manualInstallCommand: "npm install -g @openai/codex@latest",
      }),
    });

    const status = await checker.getStatus();
    expect(status).toMatchObject({
      installed: "0.4.2",
      installedPath: "/usr/local/bin/codex",
      installedPackage: "@openai/codex",
      updateMethod: "npm",
      manualInstallCommand: "npm install -g @openai/codex@latest",
      latest: "0.4.3",
      releaseUrl: "https://github.com/openai/codex/releases/tag/v0.4.3",
      updateAvailable: true,
      error: null,
    });
    expect(status.lastCheckedAt).toBeTypeOf("number");
  });

  it("does not mark update available when installed >= latest", async () => {
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({ version: "0.4.3", path: null }),
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
    });
    const status = await checker.getStatus();
    expect(status.updateAvailable).toBe(false);
    expect(status.updateMethod).toBe("manual");
  });

  it("surfaces fetch errors without throwing", async () => {
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({ version: "0.4.2", path: null }),
      fetchLatest: async () => {
        throw new Error("network down");
      },
    });
    const status = await checker.getStatus();
    expect(status.error).toBe("network down");
    expect(status.latest).toBeNull();
    expect(status.updateAvailable).toBe(false);
  });

  it("tolerates missing installed CLI", async () => {
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({ version: null, path: null }),
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
    });
    const status = await checker.getStatus();
    expect(status.installed).toBeNull();
    expect(status.updateAvailable).toBe(false);
  });

  it("caches within TTL and re-fetches when forced", async () => {
    const detect = vi.fn(async () => ({ version: "0.4.2", path: null }));
    const fetchLatest = vi.fn(async () => ({
      tagName: "v0.4.3",
      htmlUrl: null,
    }));
    const checker = new CodexUpdateChecker({
      detectInstalled: detect,
      fetchLatest,
      refreshTtlMs: 60_000,
    });

    await checker.getStatus();
    await checker.getStatus();
    expect(detect).toHaveBeenCalledTimes(1);
    expect(fetchLatest).toHaveBeenCalledTimes(1);

    await checker.getStatus({ force: true });
    expect(detect).toHaveBeenCalledTimes(2);
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("coalesces concurrent refreshes", async () => {
    let resolveLatest: (v: { tagName: string; htmlUrl: null }) => void =
      () => {};
    const fetchLatest = vi.fn(
      () =>
        new Promise<{ tagName: string; htmlUrl: null }>((resolve) => {
          resolveLatest = resolve;
        }),
    );
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({ version: "0.4.2", path: null }),
      fetchLatest,
    });

    const a = checker.getStatus();
    const b = checker.getStatus();
    // Flush pending microtasks so doRefresh reaches fetchLatest() before we resolve it.
    await new Promise((resolve) => setImmediate(resolve));
    resolveLatest({ tagName: "v0.4.3", htmlUrl: null });
    await Promise.all([a, b]);
    expect(fetchLatest).toHaveBeenCalledTimes(1);
  });

  it("install() refuses when updateMethod is manual", async () => {
    const runInstall = vi.fn(async () => "should not run");
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({
        version: "0.4.2",
        path: "/opt/homebrew/bin/codex",
      }),
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: null,
        updateMethod: "manual",
        manualInstallCommand: "brew upgrade codex",
      }),
      runInstall,
      installationCoordinator: immediateInstallationCoordinator,
    });

    const result = await checker.install();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/manual/i);
    expect(runInstall).not.toHaveBeenCalled();
    expect(result.status.manualInstallCommand).toBe("brew upgrade codex");
  });

  it("install() runs npm install and refreshes on success", async () => {
    const versions = ["0.4.2", "0.4.2", "0.4.3"];
    const detectInstalled = vi.fn(async () => ({
      version: versions.shift() ?? "0.4.3",
      path: "/usr/local/bin/codex",
    }));
    const runInstall = vi.fn(async (pkg: string) => `installed ${pkg}`);
    const checker = new CodexUpdateChecker({
      detectInstalled,
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: "@openai/codex",
        updateMethod: "npm",
        manualInstallCommand: "npm install -g @openai/codex@latest",
      }),
      runInstall,
      installationCoordinator: immediateInstallationCoordinator,
    });

    const result = await checker.install();
    expect(result.success).toBe(true);
    expect(result.output).toBe("installed @openai/codex");
    expect(runInstall).toHaveBeenCalledWith("@openai/codex");
    expect(result.status.installed).toBe("0.4.3");
    expect(result.status.updateAvailable).toBe(false);
  });

  it("install() surfaces errors from the install command", async () => {
    const runInstall = vi.fn(async () => {
      throw Object.assign(new Error("npm ERR! permission denied"), {
        stdout: "",
        stderr: "EACCES",
      });
    });
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({
        version: "0.4.2",
        path: "/usr/local/bin/codex",
      }),
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: "@openai/codex",
        updateMethod: "npm",
        manualInstallCommand: "npm install -g @openai/codex@latest",
      }),
      runInstall,
      installationCoordinator: immediateInstallationCoordinator,
    });

    const result = await checker.install();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/permission denied/);
    expect(result.output).toBe("EACCES");
  });

  it("refuses an inferred npm package outside the Codex allowlist", async () => {
    const runInstall = vi.fn(async () => "should not run");
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({
        version: "0.4.2",
        path: "/usr/local/bin/codex",
      }),
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: "unexpected-package",
        updateMethod: "npm",
        manualInstallCommand: null,
      }),
      runInstall,
      installationCoordinator: immediateInstallationCoordinator,
    });

    const result = await checker.install();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/unrecognized/i);
    expect(runInstall).not.toHaveBeenCalled();
  });

  it("fails an npm success that leaves the old version installed", async () => {
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({
        version: "0.4.2",
        path: "/usr/local/bin/codex",
      }),
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: "@openai/codex",
        updateMethod: "npm",
        manualInstallCommand: "npm install -g @openai/codex@latest",
      }),
      runInstall: async () => "npm exited zero",
      installationCoordinator: immediateInstallationCoordinator,
    });

    const result = await checker.install();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/still reports 0\.4\.2/);
    expect(result.error).toMatch(/expected at least 0\.4\.3/);
    expect(result.status.installed).toBe("0.4.2");
    expect(result.status.updateAvailable).toBe(true);
  });

  it("fails an npm success whose production CLI verification is unavailable", async () => {
    const versions = ["0.4.2", "0.4.2", null];
    const checker = new CodexUpdateChecker({
      detectInstalled: async () => ({
        version: versions.shift() ?? null,
        path: "/usr/local/bin/codex",
      }),
      fetchLatest: async () => ({ tagName: "v0.4.3", htmlUrl: null }),
      detectInstallMetadata: async () => ({
        installedPackage: "@openai/codex",
        updateMethod: "npm",
        manualInstallCommand: "npm install -g @openai/codex@latest",
      }),
      runInstall: async () => "npm exited zero",
      installationCoordinator: immediateInstallationCoordinator,
    });

    const result = await checker.install();
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/production CLI probe/i);
    expect(result.status.installed).toBeNull();
  });
});
