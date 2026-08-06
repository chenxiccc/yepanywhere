import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MacHostAwakeBackend,
  parseMacPowerSnapshot,
} from "../../src/services/host-awake/MacHostAwakeBackend.js";

function fakeChild(): ChildProcess {
  const child = new EventEmitter() as ChildProcess;
  Object.assign(child, {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      child.emit("exit", 0, null);
      return true;
    }),
  });
  return child;
}

describe("MacHostAwakeBackend", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("parses battery and mains snapshots from pmset", () => {
    expect(
      parseMacPowerSnapshot(
        "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t9%; discharging",
        123,
      ),
    ).toEqual({
      hasInternalBattery: true,
      powerSource: "battery",
      batteryPercent: 9,
      powerObservedAt: 123,
    });
    expect(parseMacPowerSnapshot("Now drawing from 'AC Power'\n", 456)).toEqual(
      {
        hasInternalBattery: false,
        powerSource: "external",
        powerObservedAt: 456,
      },
    );
  });

  it("uses fixed pmset and caffeinate commands without a shell", async () => {
    const child = fakeChild();
    const runCommand = vi.fn(async () => ({
      stdout: "Now drawing from 'AC Power'\n",
      stderr: "",
    }));
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const backend = new MacHostAwakeBackend({
      runCommand,
      spawnProcess,
      parentPid: 4321,
      sampleIntervalMs: 60_000,
    });

    const lease = await backend.acquire(
      { mode: "idle", batteryFloorPercent: 10 },
      vi.fn(),
    );

    expect(runCommand).toHaveBeenCalledTimes(1);
    expect(runCommand).toHaveBeenCalledWith("/usr/bin/pmset", ["-g", "batt"], {
      timeoutMs: 5_000,
      maxBufferBytes: 16 * 1024,
    });
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/caffeinate",
      ["-i", "-w", "4321"],
      { stdio: ["ignore", "ignore", "ignore"] },
    );

    await lease.release();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("does not assert awake at or below the battery floor", async () => {
    const spawnProcess = vi.fn(() => fakeChild());
    const backend = new MacHostAwakeBackend({
      runCommand: vi.fn(async () => ({
        stdout:
          "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t10%; discharging",
        stderr: "",
      })),
      spawnProcess,
      sampleIntervalMs: 60_000,
    });

    const lease = await backend.acquire(
      { mode: "idle", batteryFloorPercent: 10 },
      vi.fn(),
    );

    expect(lease.status().state).toBe("paused-low-battery");
    expect(spawnProcess).not.toHaveBeenCalled();
    await lease.release();
  });

  it("waits for the two-point hysteresis boundary before reacquiring", async () => {
    vi.useFakeTimers();
    const child = fakeChild();
    const percentages = [10, 11, 12];
    const runCommand = vi.fn(async () => ({
      stdout: `Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t${percentages.shift() ?? 12}%; discharging`,
      stderr: "",
    }));
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const backend = new MacHostAwakeBackend({
      runCommand,
      spawnProcess,
      sampleIntervalMs: 1_000,
    });
    const lease = await backend.acquire(
      { mode: "idle", batteryFloorPercent: 10 },
      vi.fn(),
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(lease.status().state).toBe("paused-low-battery");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(lease.status().state).toBe("active");
    await lease.release();
  });

  it("records an unexpected helper exit once without restarting it", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const child = fakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    const backend = new MacHostAwakeBackend({
      runCommand: vi.fn(async () => ({
        stdout: "Now drawing from 'AC Power'\n",
        stderr: "",
      })),
      spawnProcess,
      sampleIntervalMs: 1_000,
    });
    const lease = await backend.acquire(
      { mode: "idle", batteryFloorPercent: 10 },
      vi.fn(),
    );

    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(lease.status().state).toBe("error");
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    await lease.release();
  });
});
