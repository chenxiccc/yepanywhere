import { type ChildProcess, execFile, spawn } from "node:child_process";
import type { HostAwakeFeatureSupport } from "@yep-anywhere/shared";
import type {
  HostAwakeBackend,
  HostAwakeBackendStatus,
  HostAwakeLease,
  HostAwakeRequest,
  HostPowerSnapshot,
} from "./HostAwakeBackend.js";

const MAC_POWER_SAMPLE_TIMEOUT_MS = 5_000;
const MAC_POWER_SAMPLE_MAX_BUFFER_BYTES = 16 * 1024;
const MAC_POWER_SAMPLE_INTERVAL_MS = 60_000;
const CHILD_RELEASE_TIMEOUT_MS = 2_000;

export interface CommandResult {
  stdout: string;
  stderr: string;
}

export type RunCommand = (
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBufferBytes: number },
) => Promise<CommandResult>;

export type SpawnProcess = (
  executable: string,
  args: readonly string[],
  options: { stdio: ["ignore", "ignore", "ignore"] },
) => ChildProcess;

export interface MacHostAwakeBackendOptions {
  runCommand?: RunCommand;
  spawnProcess?: SpawnProcess;
  now?: () => number;
  parentPid?: number;
  sampleIntervalMs?: number;
}

function defaultRunCommand(
  executable: string,
  args: readonly string[],
  options: { timeoutMs: number; maxBufferBytes: number },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: options.maxBufferBytes,
      },
      (error, stdout, stderr) => {
        if (error) {
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
}

function defaultSpawnProcess(
  executable: string,
  args: readonly string[],
  options: { stdio: ["ignore", "ignore", "ignore"] },
): ChildProcess {
  return spawn(executable, [...args], options);
}

export function parseMacPowerSnapshot(
  output: string,
  observedAt: number,
): HostPowerSnapshot {
  const sourceMatch = output.match(/Now drawing from '([^']+)'/i);
  const source = sourceMatch?.[1]?.toLowerCase();
  const percentMatch = output.match(/\b(\d{1,3})%;/);
  const parsedPercent = percentMatch ? Number(percentMatch[1]) : undefined;
  const hasInternalBattery =
    /InternalBattery/i.test(output) || parsedPercent !== undefined;

  let powerSource: HostPowerSnapshot["powerSource"] = "unknown";
  if (source?.includes("battery")) {
    powerSource = "battery";
  } else if (source?.includes("ac") || !hasInternalBattery) {
    powerSource = "external";
  }

  return {
    hasInternalBattery,
    powerSource,
    ...(parsedPercent !== undefined &&
    parsedPercent >= 0 &&
    parsedPercent <= 100
      ? { batteryPercent: parsedPercent }
      : {}),
    powerObservedAt: observedAt,
  };
}

async function waitForChildExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off("exit", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish();
    }, CHILD_RELEASE_TIMEOUT_MS);
    timer.unref?.();
    child.once("exit", finish);
    child.kill("SIGTERM");
  });
}

class MacHostAwakeLease implements HostAwakeLease {
  private currentStatus: HostAwakeBackendStatus;
  private helper: ChildProcess | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private reconcilePromise: Promise<void> | null = null;
  private released = false;
  private helperFailed = false;
  private intentionalHelperStops = new WeakSet<ChildProcess>();
  private initialSnapshot: HostPowerSnapshot | null;

  constructor(
    private readonly backend: MacHostAwakeBackend,
    private readonly request: HostAwakeRequest,
    initialSnapshot: HostPowerSnapshot,
    private readonly onStatus: (status: HostAwakeBackendStatus) => void,
  ) {
    this.initialSnapshot = initialSnapshot;
    this.currentStatus = {
      ...initialSnapshot,
      state: "error",
      reason: "Host-awake assertion has not started",
    };
  }

  async initialize(): Promise<void> {
    const snapshot = this.initialSnapshot;
    this.initialSnapshot = null;
    if (snapshot) await this.reconcile(snapshot);
    this.timer = setInterval(() => {
      void this.sampleAndReconcile();
    }, this.backend.sampleIntervalMs);
    this.timer.unref?.();
  }

  status(): HostAwakeBackendStatus {
    return { ...this.currentStatus };
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.reconcilePromise;
    await this.stopHelper();
  }

  private async sampleAndReconcile(): Promise<void> {
    if (this.released || this.reconcilePromise) return;
    const work = this.backend
      .probe()
      .then((snapshot) => this.reconcile(snapshot))
      .catch((error) => this.handleProbeError(error))
      .finally(() => {
        if (this.reconcilePromise === work) this.reconcilePromise = null;
      });
    this.reconcilePromise = work;
    await work;
  }

  private async reconcile(snapshot: HostPowerSnapshot): Promise<void> {
    if (this.released) return;

    const batteryStateUnknown =
      snapshot.hasInternalBattery === "unknown" ||
      (snapshot.hasInternalBattery &&
        (snapshot.powerSource === "unknown" ||
          snapshot.batteryPercent === undefined));
    if (batteryStateUnknown) {
      await this.stopHelper();
      this.setStatus({
        ...snapshot,
        state: "error",
        reason: "Battery status is unavailable",
      });
      return;
    }

    const pausedForLowBattery =
      snapshot.hasInternalBattery === true &&
      snapshot.powerSource === "battery" &&
      snapshot.batteryPercent !== undefined &&
      (this.currentStatus.state === "paused-low-battery"
        ? snapshot.batteryPercent < this.request.batteryFloorPercent + 2
        : snapshot.batteryPercent <= this.request.batteryFloorPercent);

    if (pausedForLowBattery) {
      await this.stopHelper();
      this.setStatus({ ...snapshot, state: "paused-low-battery" });
      return;
    }

    if (this.helperFailed) {
      this.setStatus({
        ...snapshot,
        state: "error",
        reason: "The macOS caffeinate helper exited unexpectedly",
      });
      return;
    }

    if (!this.helper) {
      try {
        this.helper = await this.backend.startCaffeinate();
        this.observeHelper(this.helper);
      } catch (error) {
        this.helperFailed = true;
        this.setStatus({
          ...snapshot,
          state: "error",
          reason: error instanceof Error ? error.message : String(error),
        });
        return;
      }
    }
    this.setStatus({ ...snapshot, state: "active" });
  }

  private async handleProbeError(error: unknown): Promise<void> {
    await this.stopHelper();
    this.setStatus({
      hasInternalBattery: "unknown",
      powerSource: "unknown",
      powerObservedAt: this.backend.now(),
      state: "error",
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  private observeHelper(child: ChildProcess): void {
    let failureReported = false;
    const reportUnexpectedFailure = () => {
      if (failureReported) return;
      failureReported = true;
      if (this.helper === child) this.helper = null;
      if (this.released || this.intentionalHelperStops.has(child)) return;
      this.helperFailed = true;
      console.warn("[HostAwake] macOS caffeinate helper exited unexpectedly");
      this.setStatus({
        ...this.currentStatus,
        state: "error",
        reason: "The macOS caffeinate helper exited unexpectedly",
      });
    };
    child.once("exit", reportUnexpectedFailure);
    child.once("error", reportUnexpectedFailure);
  }

  private async stopHelper(): Promise<void> {
    const child = this.helper;
    if (!child) return;
    this.helper = null;
    this.intentionalHelperStops.add(child);
    await waitForChildExit(child);
  }

  private setStatus(status: HostAwakeBackendStatus): void {
    this.currentStatus = status;
    this.onStatus(this.status());
  }
}

export class MacHostAwakeBackend implements HostAwakeBackend {
  readonly platform = "darwin" as const;
  readonly support: HostAwakeFeatureSupport = {
    idleSleepPrevention: true,
    batteryFloor: true,
    closedLidOnExternalPower: false,
  };
  readonly sampleIntervalMs: number;
  private readonly runCommand: RunCommand;
  private readonly spawnProcess: SpawnProcess;
  private readonly parentPid: number;
  readonly now: () => number;

  constructor(options: MacHostAwakeBackendOptions = {}) {
    this.runCommand = options.runCommand ?? defaultRunCommand;
    this.spawnProcess = options.spawnProcess ?? defaultSpawnProcess;
    this.parentPid = options.parentPid ?? process.pid;
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs =
      options.sampleIntervalMs ?? MAC_POWER_SAMPLE_INTERVAL_MS;
  }

  async probe(): Promise<HostPowerSnapshot> {
    const result = await this.runCommand("/usr/bin/pmset", ["-g", "batt"], {
      timeoutMs: MAC_POWER_SAMPLE_TIMEOUT_MS,
      maxBufferBytes: MAC_POWER_SAMPLE_MAX_BUFFER_BYTES,
    });
    return parseMacPowerSnapshot(result.stdout, this.now());
  }

  async acquire(
    request: HostAwakeRequest,
    onStatus: (status: HostAwakeBackendStatus) => void,
  ): Promise<HostAwakeLease> {
    if (request.mode !== "idle") {
      throw new Error("Closed-lid host-awake mode is not supported yet");
    }
    const snapshot = await this.probe();
    const lease = new MacHostAwakeLease(this, request, snapshot, onStatus);
    await lease.initialize();
    return lease;
  }

  startCaffeinate(): Promise<ChildProcess> {
    const child = this.spawnProcess(
      "/usr/bin/caffeinate",
      ["-i", "-w", String(this.parentPid)],
      { stdio: ["ignore", "ignore", "ignore"] },
    );
    return new Promise((resolve, reject) => {
      const onSpawn = () => {
        child.off("error", onError);
        resolve(child);
      };
      const onError = (error: Error) => {
        child.off("spawn", onSpawn);
        reject(error);
      };
      child.once("spawn", onSpawn);
      child.once("error", onError);
    });
  }
}
