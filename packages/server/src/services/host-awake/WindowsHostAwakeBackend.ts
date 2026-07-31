import {
  type ChildProcessWithoutNullStreams,
  spawn,
} from "node:child_process";
import * as path from "node:path";
import type {
  HostAwakeFeatureSupport,
  HostAwakePowerSource,
} from "@yep-anywhere/shared";
import {
  type HostAwakeBackend,
  type HostAwakeBackendStatus,
  type HostAwakeLease,
  type HostAwakeRequest,
  type HostPowerSnapshot,
  HostAwakeUnsupportedError,
} from "./HostAwakeBackend.js";

const WINDOWS_HELPER_START_TIMEOUT_MS = 8_000;
const WINDOWS_HELPER_OUTPUT_LIMIT_BYTES = 16 * 1024;
const WINDOWS_HELPER_RELEASE_TIMEOUT_MS = 2_000;

export const WINDOWS_HOST_AWAKE_BOOTSTRAP_COMMAND =
  "& ([scriptblock]::Create([Console]::In.ReadToEnd()))";

export const WINDOWS_HOST_AWAKE_HELPER_SOURCE = `
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class YepAnywherePower {
  [StructLayout(LayoutKind.Sequential)]
  public struct ReasonContext {
    public UInt32 Version;
    public UInt32 Flags;
    public IntPtr SimpleReasonString;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct SystemPowerStatus {
    public Byte ACLineStatus;
    public Byte BatteryFlag;
    public Byte BatteryLifePercent;
    public Byte SystemStatusFlag;
    public Int32 BatteryLifeTime;
    public Int32 BatteryFullLifeTime;
  }

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr PowerCreateRequest(ref ReasonContext context);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool PowerSetRequest(IntPtr handle, Int32 requestType);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool PowerClearRequest(IntPtr handle, Int32 requestType);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool GetSystemPowerStatus(out SystemPowerStatus status);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(UInt32 desiredAccess, bool inheritHandle, UInt32 processId);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern UInt32 WaitForSingleObject(IntPtr handle, UInt32 milliseconds);

  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);
}
'@

function Write-YaStatus([hashtable]$Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Read-YaPowerSnapshot {
  $native = New-Object YepAnywherePower+SystemPowerStatus
  if (-not [YepAnywherePower]::GetSystemPowerStatus([ref]$native)) {
    throw "GetSystemPowerStatus failed"
  }

  $hasBattery = if ($native.BatteryFlag -eq 255) {
    'unknown'
  } elseif (($native.BatteryFlag -band 128) -ne 0) {
    $false
  } else {
    $true
  }
  $powerSource = if ($native.ACLineStatus -eq 1) {
    'external'
  } elseif ($native.ACLineStatus -eq 0) {
    'battery'
  } else {
    'unknown'
  }
  $batteryPercent = if ($hasBattery -eq $true -and $native.BatteryLifePercent -ne 255) {
    [int]$native.BatteryLifePercent
  } else {
    $null
  }

  return @{
    hasInternalBattery = $hasBattery
    powerSource = $powerSource
    batteryPercent = $batteryPercent
    powerObservedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  }
}

$PowerRequestSystemRequired = 1

try {
  $probeOnly = $env:YEP_HOST_AWAKE_PROBE_ONLY -eq '1'
  if ($probeOnly) {
    $snapshot = Read-YaPowerSnapshot
    $snapshot.kind = 'snapshot'
    Write-YaStatus $snapshot
    exit 0
  }

  $parentPid = [UInt32]::Parse($env:YEP_HOST_AWAKE_PARENT_PID)
  $floor = [int]::Parse($env:YEP_HOST_AWAKE_FLOOR_PERCENT)
  $parentHandle = [YepAnywherePower]::OpenProcess(0x00100000, $false, $parentPid)
  if ($parentHandle -eq [IntPtr]::Zero) {
    throw "Could not open the YA parent process"
  }

  $reasonPointer = [Runtime.InteropServices.Marshal]::StringToHGlobalUni(
    'Keep the Yep Anywhere host reachable while the server is running'
  )
  $context = New-Object YepAnywherePower+ReasonContext
  $context.Version = 0
  $context.Flags = 1
  $context.SimpleReasonString = $reasonPointer
  $requestHandle = [YepAnywherePower]::PowerCreateRequest([ref]$context)
  if ($requestHandle -eq [IntPtr]::Zero -or $requestHandle -eq [IntPtr](-1)) {
    throw "PowerCreateRequest failed"
  }

  $requestSet = $false
  $pausedForLowBattery = $false
  try {
    while ($true) {
      try {
        $snapshot = Read-YaPowerSnapshot
        $batteryUnknown =
          $snapshot.hasInternalBattery -eq 'unknown' -or
          ($snapshot.hasInternalBattery -eq $true -and
            ($snapshot.powerSource -eq 'unknown' -or $null -eq $snapshot.batteryPercent))

        if ($batteryUnknown) {
          if ($requestSet) {
            [void][YepAnywherePower]::PowerClearRequest($requestHandle, $PowerRequestSystemRequired)
            $requestSet = $false
          }
          $snapshot.state = 'error'
          $snapshot.reason = 'Battery status is unavailable'
        } else {
          $lowBattery =
            $snapshot.hasInternalBattery -eq $true -and
            $snapshot.powerSource -eq 'battery' -and
            (($pausedForLowBattery -and $snapshot.batteryPercent -lt ($floor + 2)) -or
              (-not $pausedForLowBattery -and $snapshot.batteryPercent -le $floor))

          if ($lowBattery) {
            $pausedForLowBattery = $true
            if ($requestSet) {
              [void][YepAnywherePower]::PowerClearRequest($requestHandle, $PowerRequestSystemRequired)
              $requestSet = $false
            }
            $snapshot.state = 'paused-low-battery'
          } else {
            $pausedForLowBattery = $false
            if (-not $requestSet) {
              if (-not [YepAnywherePower]::PowerSetRequest($requestHandle, $PowerRequestSystemRequired)) {
                throw "PowerSetRequest failed"
              }
              $requestSet = $true
            }
            $snapshot.state = 'active'
          }
        }
        $snapshot.kind = 'status'
        Write-YaStatus $snapshot
      } catch {
        $fatalRequestFailure = $_.Exception.Message -eq 'PowerSetRequest failed'
        if ($requestSet) {
          [void][YepAnywherePower]::PowerClearRequest($requestHandle, $PowerRequestSystemRequired)
          $requestSet = $false
        }
        Write-YaStatus @{
          kind = 'status'
          state = 'error'
          reason = $_.Exception.Message
          hasInternalBattery = 'unknown'
          powerSource = 'unknown'
          powerObservedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        }
        if ($fatalRequestFailure) { throw }
      }

      $waitResult = [YepAnywherePower]::WaitForSingleObject($parentHandle, 60000)
      if ($waitResult -eq 0) { break }
      if ($waitResult -ne 258) { throw "Parent process wait failed" }
    }
  } finally {
    if ($requestSet) {
      [void][YepAnywherePower]::PowerClearRequest($requestHandle, $PowerRequestSystemRequired)
    }
    if ($requestHandle -ne [IntPtr]::Zero -and $requestHandle -ne [IntPtr](-1)) {
      [void][YepAnywherePower]::CloseHandle($requestHandle)
    }
    if ($parentHandle -ne [IntPtr]::Zero) {
      [void][YepAnywherePower]::CloseHandle($parentHandle)
    }
    if ($reasonPointer -ne [IntPtr]::Zero) {
      [Runtime.InteropServices.Marshal]::FreeHGlobal($reasonPointer)
    }
  }
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`;

export interface WindowsHostAwakeBackendOptions {
  spawnProcess?: typeof spawn;
  powershellPath?: string;
  parentPid?: number;
}

interface WindowsHelperPayload {
  kind?: string;
  state?: string;
  reason?: string;
  hasInternalBattery?: boolean | "unknown";
  powerSource?: HostAwakePowerSource;
  batteryPercent?: number | null;
  powerObservedAt?: number;
}

function defaultPowerShellPath(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR ?? "C:\\Windows";
  return path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function boundedAppend(current: string, chunk: Buffer | string): string {
  if (Buffer.byteLength(current) >= WINDOWS_HELPER_OUTPUT_LIMIT_BYTES) {
    return current;
  }
  const next = current + chunk.toString();
  return Buffer.byteLength(next) <= WINDOWS_HELPER_OUTPUT_LIMIT_BYTES
    ? next
    : next.slice(0, WINDOWS_HELPER_OUTPUT_LIMIT_BYTES);
}

function parsePayload(line: string): WindowsHelperPayload | null {
  try {
    const parsed = JSON.parse(line) as WindowsHelperPayload;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function safeHelperFailure(stderr: string): string {
  const normalized = stderr.toLowerCase();
  if (
    normalized.includes("constrainedlanguage") ||
    normalized.includes("add-type") ||
    normalized.includes("application control")
  ) {
    return "Windows application policy blocked the required power APIs";
  }
  return "Windows PowerShell power APIs are unavailable";
}

function payloadToSnapshot(payload: WindowsHelperPayload): HostPowerSnapshot {
  const hasInternalBattery =
    typeof payload.hasInternalBattery === "boolean" ||
    payload.hasInternalBattery === "unknown"
      ? payload.hasInternalBattery
      : "unknown";
  const powerSource =
    payload.powerSource === "battery" ||
    payload.powerSource === "external" ||
    payload.powerSource === "unknown"
      ? payload.powerSource
      : "unknown";
  return {
    hasInternalBattery,
    powerSource,
    ...(typeof payload.batteryPercent === "number"
      ? { batteryPercent: payload.batteryPercent }
      : {}),
    powerObservedAt:
      typeof payload.powerObservedAt === "number"
        ? payload.powerObservedAt
        : Date.now(),
  };
}

function payloadToStatus(payload: WindowsHelperPayload): HostAwakeBackendStatus {
  const snapshot = payloadToSnapshot(payload);
  const state =
    payload.state === "active" ||
    payload.state === "paused-low-battery" ||
    payload.state === "error"
      ? payload.state
      : "error";
  return {
    ...snapshot,
    state,
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
  };
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
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
    }, WINDOWS_HELPER_RELEASE_TIMEOUT_MS);
    timer.unref?.();
    child.once("exit", finish);
    child.kill();
  });
}

class WindowsHostAwakeLease implements HostAwakeLease {
  private released = false;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private currentStatus: HostAwakeBackendStatus,
  ) {}

  status(): HostAwakeBackendStatus {
    return { ...this.currentStatus };
  }

  update(status: HostAwakeBackendStatus): void {
    this.currentStatus = status;
  }

  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await waitForChildExit(this.child);
    }
  }

  isReleased(): boolean {
    return this.released;
  }
}

export class WindowsHostAwakeBackend implements HostAwakeBackend {
  readonly platform = "win32" as const;
  readonly support: HostAwakeFeatureSupport = {
    idleSleepPrevention: true,
    batteryFloor: true,
    closedLidOnExternalPower: false,
  };
  private readonly spawnProcess: typeof spawn;
  private readonly powershellPath: string;
  private readonly parentPid: number;

  constructor(options: WindowsHostAwakeBackendOptions = {}) {
    this.spawnProcess = options.spawnProcess ?? spawn;
    this.powershellPath = options.powershellPath ?? defaultPowerShellPath();
    this.parentPid = options.parentPid ?? process.pid;
  }

  async probe(): Promise<HostPowerSnapshot> {
    const child = this.startHelper({ probeOnly: true, batteryFloorPercent: 10 });
    try {
      return await new Promise<HostPowerSnapshot>((resolve, reject) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          child.kill();
          reject(new HostAwakeUnsupportedError("Windows power probe timed out"));
        }, WINDOWS_HELPER_START_TIMEOUT_MS);
        timer.unref?.();

        const finish = (callback: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          callback();
        };

        child.stdout.on("data", (chunk) => {
          stdout = boundedAppend(stdout, chunk);
        });
        child.stderr.on("data", (chunk) => {
          stderr = boundedAppend(stderr, chunk);
        });
        child.once("error", () => {
          finish(() =>
            reject(
              new HostAwakeUnsupportedError(
                "Windows PowerShell is unavailable",
              ),
            ),
          );
        });
        child.once("exit", (code) => {
          finish(() => {
            const payload = stdout
              .split(/\r?\n/)
              .map(parsePayload)
              .find((value) => value?.kind === "snapshot");
            if (code === 0 && payload) {
              resolve(payloadToSnapshot(payload));
              return;
            }
            reject(new HostAwakeUnsupportedError(safeHelperFailure(stderr)));
          });
        });
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
  }

  async acquire(
    request: HostAwakeRequest,
    onStatus: (status: HostAwakeBackendStatus) => void,
  ): Promise<HostAwakeLease> {
    if (request.mode !== "idle") {
      throw new Error("Closed-lid host-awake mode is not supported on Windows");
    }
    const child = this.startHelper({
      probeOnly: false,
      batteryFloorPercent: request.batteryFloorPercent,
    });

    return new Promise<HostAwakeLease>((resolve, reject) => {
      let stdoutBuffer = "";
      let stderr = "";
      let lease: WindowsHostAwakeLease | null = null;
      let settled = false;
      let helperFailureReported = false;
      const timer = setTimeout(() => {
        child.kill();
        if (!settled) {
          settled = true;
          reject(new Error("Windows host-awake helper timed out"));
        }
      }, WINDOWS_HELPER_START_TIMEOUT_MS);
      timer.unref?.();

      const handleLine = (line: string) => {
        const payload = parsePayload(line);
        if (payload?.kind !== "status") return;
        const status = payloadToStatus(payload);
        if (!lease) {
          lease = new WindowsHostAwakeLease(child, status);
          settled = true;
          clearTimeout(timer);
          resolve(lease);
          return;
        }
        lease.update(status);
        onStatus(status);
      };

      const reportUnexpectedFailure = () => {
        if (helperFailureReported || !lease || lease.isReleased()) return;
        helperFailureReported = true;
        console.warn("[HostAwake] Windows power helper exited unexpectedly");
        const previous = lease.status();
        const status: HostAwakeBackendStatus = {
          ...previous,
          state: "error",
          reason:
            previous.state === "error" && previous.reason
              ? previous.reason
              : "Windows host-awake helper exited unexpectedly",
        };
        lease.update(status);
        onStatus(status);
      };

      child.stdout.on("data", (chunk) => {
        stdoutBuffer = boundedAppend(stdoutBuffer, chunk);
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() ?? "";
        for (const line of lines) handleLine(line);
      });
      child.stderr.on("data", (chunk) => {
        stderr = boundedAppend(stderr, chunk);
      });
      child.once("error", () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(
            new HostAwakeUnsupportedError(
              "Windows PowerShell is unavailable",
            ),
          );
          return;
        }
        reportUnexpectedFailure();
      });
      child.once("exit", () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(new HostAwakeUnsupportedError(safeHelperFailure(stderr)));
          return;
        }
        reportUnexpectedFailure();
      });
    });
  }

  private startHelper(options: {
    probeOnly: boolean;
    batteryFloorPercent: number;
  }): ChildProcessWithoutNullStreams {
    const child = this.spawnProcess(
      this.powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        WINDOWS_HOST_AWAKE_BOOTSTRAP_COMMAND,
      ],
      {
        env: {
          ...process.env,
          YEP_HOST_AWAKE_PROBE_ONLY: options.probeOnly ? "1" : "0",
          YEP_HOST_AWAKE_PARENT_PID: String(this.parentPid),
          YEP_HOST_AWAKE_FLOOR_PERCENT: String(options.batteryFloorPercent),
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    child.stdin.on("error", () => {
      // Spawn failures and policy termination can close stdin before delivery.
      // The child error/exit path reports the bounded unsupported status.
    });
    child.stdin.end(WINDOWS_HOST_AWAKE_HELPER_SOURCE);
    return child;
  }
}
