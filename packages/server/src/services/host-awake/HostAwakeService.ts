import type {
  HostAwakeMode,
  HostAwakeStatus,
  HostAwakeState,
} from "@yep-anywhere/shared";
import {
  DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT,
  isHostAwakeBatteryFloorPercent,
} from "@yep-anywhere/shared";
import {
  type HostAwakeBackend,
  type HostAwakeBackendStatus,
  type HostAwakeLease,
  type HostPowerSnapshot,
  HostAwakeUnsupportedError,
  UNSUPPORTED_HOST_AWAKE_SUPPORT,
} from "./HostAwakeBackend.js";
import { MacHostAwakeBackend } from "./MacHostAwakeBackend.js";
import { WindowsHostAwakeBackend } from "./WindowsHostAwakeBackend.js";

const DISABLED_SAMPLE_MAX_AGE_MS = 30_000;
const MAX_REASON_LENGTH = 240;

export interface HostAwakeSupportCheck {
  ok: boolean;
  status: HostAwakeStatus;
}

export interface HostAwakeServiceOptions {
  backend?: HostAwakeBackend;
  now?: () => number;
  disabledSampleMaxAgeMs?: number;
}

class UnsupportedHostAwakeBackend implements HostAwakeBackend {
  readonly support = UNSUPPORTED_HOST_AWAKE_SUPPORT;

  constructor(readonly platform: NodeJS.Platform) {}

  async probe(): Promise<HostPowerSnapshot> {
    return {
      hasInternalBattery: "unknown",
      powerSource: "unknown",
      powerObservedAt: Date.now(),
    };
  }

  async acquire(): Promise<never> {
    throw new HostAwakeUnsupportedError(
      "Host-awake control is unavailable on this platform",
    );
  }
}

export function createHostAwakeBackend(
  platform: NodeJS.Platform = process.platform,
): HostAwakeBackend {
  if (platform === "darwin") return new MacHostAwakeBackend();
  if (platform === "win32") return new WindowsHostAwakeBackend();
  return new UnsupportedHostAwakeBackend(platform);
}

function boundedReason(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const scrubbed = raw
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return (scrubbed || "Host-awake operation failed").slice(
    0,
    MAX_REASON_LENGTH,
  );
}

export class HostAwakeService {
  private readonly backend: HostAwakeBackend;
  private readonly now: () => number;
  private readonly disabledSampleMaxAgeMs: number;
  private requestedMode: HostAwakeMode = "off";
  private batteryFloorPercent = DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT;
  private lease: HostAwakeLease | null = null;
  private generation = 0;
  private operation = Promise.resolve();
  private probeInFlight: Promise<void> | null = null;
  private lastProbeAt = 0;
  private effectiveSupport;
  private currentStatus: HostAwakeStatus;

  constructor(options: HostAwakeServiceOptions = {}) {
    this.backend = options.backend ?? createHostAwakeBackend();
    this.now = options.now ?? Date.now;
    this.disabledSampleMaxAgeMs =
      options.disabledSampleMaxAgeMs ?? DISABLED_SAMPLE_MAX_AGE_MS;
    this.effectiveSupport = { ...this.backend.support };
    this.currentStatus = {
      requestedMode: "off",
      state: this.effectiveSupport.idleSleepPrevention
        ? "disabled"
        : "unsupported",
      platform: this.backend.platform,
      support: { ...this.effectiveSupport },
      hasInternalBattery: "unknown",
      powerSource: "unknown",
      batteryFloorPercent: this.batteryFloorPercent,
    };
  }

  async initialize(options: {
    mode: HostAwakeMode;
    batteryFloorPercent: number;
  }): Promise<HostAwakeStatus> {
    this.requestedMode = options.mode;
    this.batteryFloorPercent = isHostAwakeBatteryFloorPercent(
      options.batteryFloorPercent,
    )
      ? options.batteryFloorPercent
      : DEFAULT_HOST_AWAKE_BATTERY_FLOOR_PERCENT;

    if (this.requestedMode === "off") {
      await this.refreshDisabledStatus(true);
      return this.status();
    }
    return this.apply(this.requestedMode, this.batteryFloorPercent);
  }

  status(): HostAwakeStatus {
    return {
      ...this.currentStatus,
      support: { ...this.currentStatus.support },
    };
  }

  async getStatus(
    options: { forceRefresh?: boolean } = {},
  ): Promise<HostAwakeStatus> {
    if (!this.lease && this.requestedMode === "off") {
      const stale =
        this.lastProbeAt === 0 ||
        this.now() - this.lastProbeAt >= this.disabledSampleMaxAgeMs;
      if (options.forceRefresh || stale) {
        await this.refreshDisabledStatus(true);
      }
    }
    return this.status();
  }

  async checkSupport(
    mode: Exclude<HostAwakeMode, "off">,
  ): Promise<HostAwakeSupportCheck> {
    if (!this.lease) await this.refreshDisabledStatus(true);

    let reason: string | undefined;
    if (!this.effectiveSupport.idleSleepPrevention) {
      reason =
        this.currentStatus.reason ??
        "Host-awake control is unavailable on this server";
    } else if (
      mode === "idle-and-closed-lid-on-external-power" &&
      !this.effectiveSupport.closedLidOnExternalPower
    ) {
      reason = "Closed-lid host-awake control is unavailable on this server";
    } else if (this.currentStatus.hasInternalBattery === "unknown") {
      reason = "Battery presence could not be determined safely";
    } else if (
      this.currentStatus.hasInternalBattery &&
      !this.effectiveSupport.batteryFloor
    ) {
      reason = "Battery-floor protection is unavailable on this server";
    }

    if (!reason) return { ok: true, status: this.status() };
    return {
      ok: false,
      status: { ...this.status(), state: "unsupported", reason },
    };
  }

  async apply(
    mode: HostAwakeMode,
    batteryFloorPercent: number,
  ): Promise<HostAwakeStatus> {
    return this.enqueue(async () => {
      this.requestedMode = mode;
      this.batteryFloorPercent = batteryFloorPercent;
      const generation = ++this.generation;
      const previousLease = this.lease;
      this.lease = null;
      if (previousLease) await previousLease.release();

      if (mode === "off") {
        this.setStatus({
          state: this.effectiveSupport.idleSleepPrevention
            ? "disabled"
            : "unsupported",
          reason: undefined,
        });
        return this.status();
      }

      if (
        !this.effectiveSupport.idleSleepPrevention ||
        (mode === "idle-and-closed-lid-on-external-power" &&
          !this.effectiveSupport.closedLidOnExternalPower)
      ) {
        this.setStatus({
          state: "unsupported",
          reason: "The requested host-awake mode is unavailable on this server",
        });
        return this.status();
      }

      try {
        const lease = await this.backend.acquire(
          { mode, batteryFloorPercent },
          (backendStatus) => {
            if (generation !== this.generation) return;
            this.applyBackendStatus(backendStatus);
          },
        );
        if (generation !== this.generation) {
          await lease.release();
          return this.status();
        }
        this.lease = lease;
        this.applyBackendStatus(lease.status());
      } catch (error) {
        if (error instanceof HostAwakeUnsupportedError) {
          this.effectiveSupport = { ...UNSUPPORTED_HOST_AWAKE_SUPPORT };
          this.setStatus({
            state: "unsupported",
            reason: boundedReason(error),
          });
        } else {
          this.setStatus({ state: "error", reason: boundedReason(error) });
        }
      }
      return this.status();
    });
  }

  async shutdown(): Promise<void> {
    await this.enqueue(async () => {
      ++this.generation;
      const lease = this.lease;
      this.lease = null;
      if (lease) await lease.release();
      this.requestedMode = "off";
      this.setStatus({ state: "disabled", reason: undefined });
    });
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operation.then(operation, operation);
    this.operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async refreshDisabledStatus(force: boolean): Promise<void> {
    if (this.probeInFlight) return this.probeInFlight;
    if (!force && this.now() - this.lastProbeAt < this.disabledSampleMaxAgeMs) {
      return;
    }
    if (!this.backend.support.idleSleepPrevention) {
      this.lastProbeAt = this.now();
      this.setStatus({
        state: "unsupported",
        hasInternalBattery: "unknown",
        powerSource: "unknown",
        powerObservedAt: this.lastProbeAt,
      });
      return;
    }

    const work = this.backend
      .probe()
      .then((snapshot) => {
        this.lastProbeAt = this.now();
        this.effectiveSupport = { ...this.backend.support };
        this.applyPowerSnapshot(snapshot, "disabled");
      })
      .catch((error) => {
        this.lastProbeAt = this.now();
        if (error instanceof HostAwakeUnsupportedError) {
          this.effectiveSupport = { ...UNSUPPORTED_HOST_AWAKE_SUPPORT };
          this.setStatus({
            state: "unsupported",
            reason: boundedReason(error),
            hasInternalBattery: "unknown",
            powerSource: "unknown",
            powerObservedAt: this.lastProbeAt,
          });
          return;
        }
        this.setStatus({
          state: "error",
          reason: boundedReason(error),
          hasInternalBattery: "unknown",
          powerSource: "unknown",
          powerObservedAt: this.lastProbeAt,
        });
      })
      .finally(() => {
        if (this.probeInFlight === work) this.probeInFlight = null;
      });
    this.probeInFlight = work;
    await work;
  }

  private applyBackendStatus(status: HostAwakeBackendStatus): void {
    this.lastProbeAt = status.powerObservedAt;
    this.currentStatus = {
      requestedMode: this.requestedMode,
      state: status.state,
      platform: this.backend.platform,
      support: { ...this.effectiveSupport },
      hasInternalBattery: status.hasInternalBattery,
      powerSource: status.powerSource,
      batteryPercent: status.batteryPercent,
      powerObservedAt: status.powerObservedAt,
      batteryFloorPercent: this.batteryFloorPercent,
      ...(status.reason ? { reason: boundedReason(status.reason) } : {}),
    };
  }

  private applyPowerSnapshot(
    snapshot: HostPowerSnapshot,
    state: HostAwakeState,
  ): void {
    this.currentStatus = {
      requestedMode: this.requestedMode,
      state,
      platform: this.backend.platform,
      support: { ...this.effectiveSupport },
      hasInternalBattery: snapshot.hasInternalBattery,
      powerSource: snapshot.powerSource,
      batteryPercent: snapshot.batteryPercent,
      powerObservedAt: snapshot.powerObservedAt,
      batteryFloorPercent: this.batteryFloorPercent,
    };
  }

  private setStatus(
    updates: Partial<
      Pick<
        HostAwakeStatus,
        | "state"
        | "reason"
        | "hasInternalBattery"
        | "powerSource"
        | "powerObservedAt"
      >
    >,
  ): void {
    const next = {
      ...this.currentStatus,
      ...updates,
      requestedMode: this.requestedMode,
      platform: this.backend.platform,
      support: { ...this.effectiveSupport },
      batteryFloorPercent: this.batteryFloorPercent,
    };
    if (updates.reason === undefined) delete next.reason;
    this.currentStatus = next;
  }
}
