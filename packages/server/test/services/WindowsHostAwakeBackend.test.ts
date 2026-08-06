import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  WINDOWS_HELPER_START_TIMEOUT_MS,
  WINDOWS_HOST_AWAKE_BOOTSTRAP_COMMAND,
  WINDOWS_HOST_AWAKE_HELPER_SOURCE,
  WindowsHostAwakeBackend,
} from "../../src/services/host-awake/WindowsHostAwakeBackend.js";

function fakeChild(
  onInput: (child: ChildProcessWithoutNullStreams) => void,
): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      child.emit("exit", 0, null);
      return true;
    }),
  });
  child.stdin.once("finish", () => queueMicrotask(() => onInput(child)));
  return child;
}

describe("WindowsHostAwakeBackend", () => {
  it("parses the complete stdin helper without policy bypass or script files", async () => {
    let helperSource = "";
    const spawnProcess = vi.fn((..._args: unknown[]) => {
      const child = fakeChild((process) => {
        helperSource = process.stdin.read()?.toString() ?? "";
        process.stdout.write(
          `${JSON.stringify({
            kind: "snapshot",
            hasInternalBattery: false,
            powerSource: "external",
            powerObservedAt: 123,
          })}\n`,
        );
        process.emit("exit", 0, null);
      });
      return child;
    });
    const backend = new WindowsHostAwakeBackend({
      spawnProcess: spawnProcess as never,
      powershellPath: "C:\\Windows\\powershell.exe",
      parentPid: 1234,
    });

    await expect(backend.probe()).resolves.toMatchObject({
      hasInternalBattery: false,
      powerSource: "external",
    });

    const [executable, args, options] = spawnProcess.mock.calls[0] ?? [];
    expect(executable).toBe("C:\\Windows\\powershell.exe");
    expect(args).toEqual([
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_HOST_AWAKE_BOOTSTRAP_COMMAND,
    ]);
    expect(args).not.toContain("-ExecutionPolicy");
    expect(args).not.toContain("-File");
    expect(options).toMatchObject({ windowsHide: true });
    expect(helperSource).toBe(WINDOWS_HOST_AWAKE_HELPER_SOURCE);
  });

  it.skipIf(process.platform !== "win32")(
    "executes the real Windows PowerShell probe",
    async () => {
      const snapshot = await new WindowsHostAwakeBackend().probe();

      expect([true, false, "unknown"]).toContain(snapshot.hasInternalBattery);
      expect(["battery", "external", "unknown"]).toContain(
        snapshot.powerSource,
      );
      expect(snapshot.powerObservedAt).toBeGreaterThan(0);
    },
    WINDOWS_HELPER_START_TIMEOUT_MS + 5_000,
  );

  it("owns a PID-bound SystemRequired request and releases its helper", async () => {
    let child: ChildProcessWithoutNullStreams | null = null;
    const spawnProcess = vi.fn(() => {
      child = fakeChild((process) => {
        process.stdout.write(
          `${JSON.stringify({
            kind: "status",
            state: "active",
            hasInternalBattery: true,
            powerSource: "battery",
            batteryPercent: 80,
            powerObservedAt: 456,
          })}\n`,
        );
      });
      return child;
    });
    const backend = new WindowsHostAwakeBackend({
      spawnProcess: spawnProcess as never,
      powershellPath: "powershell.exe",
      parentPid: 9876,
    });

    const lease = await backend.acquire(
      { mode: "idle", batteryFloorPercent: 10 },
      vi.fn(),
    );

    expect(lease.status()).toMatchObject({
      state: "active",
      batteryPercent: 80,
    });
    const options = spawnProcess.mock.calls[0]?.[2] as {
      env: Record<string, string>;
    };
    expect(options.env).toMatchObject({
      YEP_HOST_AWAKE_PROBE_ONLY: "0",
      YEP_HOST_AWAKE_PARENT_PID: "9876",
      YEP_HOST_AWAKE_FLOOR_PERCENT: "10",
    });
    expect(WINDOWS_HOST_AWAKE_HELPER_SOURCE).toContain(
      "PowerRequestSystemRequired",
    );
    expect(WINDOWS_HOST_AWAKE_HELPER_SOURCE).not.toContain(
      "PowerRequestDisplayRequired",
    );

    await lease.release();
    expect(child?.kill).toHaveBeenCalled();
  });

  it("reports an unexpected helper failure once without restarting", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const onStatus = vi.fn();
    let child: ChildProcessWithoutNullStreams | null = null;
    const spawnProcess = vi.fn(() => {
      child = fakeChild((process) => {
        process.stdout.write(
          `${JSON.stringify({
            kind: "status",
            state: "active",
            hasInternalBattery: false,
            powerSource: "external",
            powerObservedAt: 456,
          })}\n`,
        );
      });
      return child;
    });
    const backend = new WindowsHostAwakeBackend({
      spawnProcess: spawnProcess as never,
      powershellPath: "powershell.exe",
    });
    const lease = await backend.acquire(
      { mode: "idle", batteryFloorPercent: 10 },
      onStatus,
    );

    child?.emit("error", new Error("helper failed"));
    child?.emit("exit", 1, null);

    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenCalledWith(
      expect.objectContaining({ state: "error" }),
    );
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    await lease.release();
    warn.mockRestore();
  });
});
