import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDevInstanceProvenance,
  devBindKey,
  findDevInstanceProcesses,
  reapObsoleteDevInstances,
} from "../../../../scripts/dev-instance-provenance.mjs";

const scratchDirs = [];

afterEach(() => {
  for (const scratchDir of scratchDirs.splice(0)) {
    rmSync(scratchDir, { recursive: true });
  }
});

function createProcRoot() {
  const procRoot = mkdtempSync(join(tmpdir(), "ya-dev-provenance-test-"));
  scratchDirs.push(procRoot);
  return procRoot;
}

function writeProcess(procRoot, {
  pid,
  startTime,
  instanceId,
  bindKey,
  sourceRoot,
}) {
  const processDir = join(procRoot, String(pid));
  mkdirSync(processDir);
  const environment = createDevInstanceProvenance({
    host: "localhost",
    port: Number(bindKey.split(":").at(-1)),
    sourceRoot,
    instanceId,
  }).env;
  environment.YEP_DEV_BIND_KEY = bindKey;
  writeFileSync(
    join(processDir, "environ"),
    `${Object.entries(environment)
      .map(([key, value]) => `${key}=${value}`)
      .join("\0")}\0`,
  );

  const fields = Array(20).fill("0");
  fields[0] = "S";
  fields[1] = "1";
  fields[19] = String(startTime);
  writeFileSync(join(processDir, "stat"), `${pid} (node) ${fields.join(" ")}`);
}

describe("YA dev bind provenance", () => {
  it("uses bind identity rather than source root for ownership", () => {
    expect(devBindKey(undefined, 3400)).toBe("loopback:3400");
    expect(devBindKey("localhost", 3400)).toBe("loopback:3400");
    expect(devBindKey("127.0.0.1", 3400)).toBe("loopback:3400");

    const first = createDevInstanceProvenance({
      host: "localhost",
      port: 3400,
      sourceRoot: "/checkout/one",
      instanceId: "one",
    });
    const second = createDevInstanceProvenance({
      host: "127.0.0.1",
      port: 3400,
      sourceRoot: "/checkout/two",
      instanceId: "two",
    });
    expect(first.bindKey).toBe(second.bindKey);
  });

  it("finds only prior processes claiming the bind", () => {
    const procRoot = createProcRoot();
    writeProcess(procRoot, {
      pid: 101,
      startTime: 1001,
      instanceId: "prior",
      bindKey: "loopback:3400",
      sourceRoot: "/checkout/one",
    });
    writeProcess(procRoot, {
      pid: 102,
      startTime: 1002,
      instanceId: "current",
      bindKey: "loopback:3400",
      sourceRoot: "/checkout/two",
    });
    writeProcess(procRoot, {
      pid: 103,
      startTime: 1003,
      instanceId: "other-port",
      bindKey: "loopback:3500",
      sourceRoot: "/checkout/one",
    });

    expect(
      findDevInstanceProcesses({
        bindKey: "loopback:3400",
        excludeInstanceId: "current",
        procRoot,
      }).map(({ pid }) => pid),
    ).toEqual([101]);
  });

  it("grants only different-source survivors the extended grace", async () => {
    const procRoot = createProcRoot();
    writeProcess(procRoot, {
      pid: 201,
      startTime: 2001,
      instanceId: "same-source",
      bindKey: "loopback:3400",
      sourceRoot: "/checkout/current",
    });
    writeProcess(procRoot, {
      pid: 202,
      startTime: 2002,
      instanceId: "different-source",
      bindKey: "loopback:3400",
      sourceRoot: "/checkout/other",
    });

    let currentTime = 0;
    const signals = [];
    const signalProcess = (pid, signal) => {
      signals.push({ pid, signal, time: currentTime });
      if (signal === "SIGKILL") {
        rmSync(join(procRoot, String(pid)), { recursive: true });
      }
    };

    const result = await reapObsoleteDevInstances({
      bindKey: "loopback:3400",
      currentInstanceId: "current",
      currentSourceRoot: "/checkout/current",
      procRoot,
      signalProcess,
      logger: { warn() {} },
      gracePeriodMs: 10_000,
      differentSourceGracePeriodMs: 60_000,
      forcePeriodMs: 1_000,
      pollIntervalMs: 1_000,
      now: () => currentTime,
      sleep: async (milliseconds) => {
        currentTime += milliseconds;
      },
    });

    expect(signals).toContainEqual({ pid: 201, signal: "SIGTERM", time: 0 });
    expect(signals).toContainEqual({ pid: 202, signal: "SIGTERM", time: 0 });
    expect(signals).toContainEqual({
      pid: 201,
      signal: "SIGKILL",
      time: 10_000,
    });
    expect(signals).toContainEqual({
      pid: 202,
      signal: "SIGKILL",
      time: 60_000,
    });
    expect(result).toEqual({ instances: 2, processes: 2, forced: 2 });
  });
});
