/**
 * One process-wide timer for every heartbeat deadline.
 *
 * Each heartbeat source — a live process, an unowned candidate — answers
 * "the earliest instant I could need attention" instead of being polled. The
 * scheduler arms a single timer for the earliest of those instants, so a
 * server with nothing opted in arms nothing at all, and an opted-in session
 * that is minutes away from its threshold is visited once, at the threshold.
 *
 * A source that cannot prove a later instant asks for the fallback recheck,
 * which is the fixed interval this scheduler replaced. That keeps the change
 * one-directional: the scheduler never sweeps more often than the fixed tick
 * did, and sweeps far less often wherever a deadline is provable.
 */

const DEFAULT_MIN_DELAY_MS = 250;
/** Bounds a deadline built from a stored anchor with a skewed clock. */
const DEFAULT_MAX_DELAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_ERROR_RETRY_MS = 30 * 1000;

export interface HeartbeatTimerHandle {
  cancel(): void;
}

export interface HeartbeatSweepSchedulerOptions {
  /**
   * Runs one sweep and returns the earliest instant any source could next need
   * attention, or null when only an event can create heartbeat work.
   */
  sweep: (nowMs: number) => Promise<number | null>;
  now?: () => number;
  /** Timer seam for tests and benchmarks; defaults to an unref'd setTimeout. */
  arm?: (fire: () => void, delayMs: number) => HeartbeatTimerHandle;
  /** Never arm shorter than this, so a due-now source cannot spin. */
  minDelayMs?: number;
  maxDelayMs?: number;
  /** Rearm delay when a sweep throws, so one failure cannot disarm heartbeats. */
  errorRetryMs?: number;
}

export interface HeartbeatSweepSchedulerMetrics {
  sweeps: number;
  arms: number;
  /** Requests satisfied by an already-armed, no-later timer. */
  coalescedRequests: number;
  sweepErrors: number;
  /** Instant the current timer fires, or null while nothing is armed. */
  armedAtMs: number | null;
}

/** The earlier of two deadlines, treating null as "no deadline". */
export function earliestDueAt(
  a: number | null,
  b: number | null,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

function defaultArm(fire: () => void, delayMs: number): HeartbeatTimerHandle {
  const timer = setTimeout(fire, delayMs);
  timer.unref?.();
  return { cancel: () => clearTimeout(timer) };
}

export class HeartbeatSweepScheduler {
  private readonly sweep: (nowMs: number) => Promise<number | null>;
  private readonly now: () => number;
  private readonly armTimer: (
    fire: () => void,
    delayMs: number,
  ) => HeartbeatTimerHandle;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly errorRetryMs: number;
  private handle: HeartbeatTimerHandle | null = null;
  private armedAtMs: number | null = null;
  private pendingArmAtMs: number | null = null;
  private running = false;
  private stopped = false;
  private sweeps = 0;
  private arms = 0;
  private coalescedRequests = 0;
  private sweepErrors = 0;

  constructor(options: HeartbeatSweepSchedulerOptions) {
    this.sweep = options.sweep;
    this.now = options.now ?? Date.now;
    this.armTimer = options.arm ?? defaultArm;
    this.minDelayMs = Math.max(0, options.minDelayMs ?? DEFAULT_MIN_DELAY_MS);
    this.maxDelayMs = Math.max(
      this.minDelayMs,
      options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
    );
    this.errorRetryMs = Math.max(
      this.minDelayMs,
      options.errorRetryMs ?? DEFAULT_ERROR_RETRY_MS,
    );
  }

  /**
   * True when a sweep is already guaranteed to run within `delayMs`. Callers
   * use this to skip the cost of deciding whether an event is even relevant.
   */
  isArmedWithin(delayMs: number): boolean {
    if (this.running) return true;
    const armed = earliestDueAt(this.armedAtMs, this.pendingArmAtMs);
    return armed !== null && armed <= this.now() + delayMs;
  }

  requestSweepWithin(delayMs: number): void {
    this.armAt(this.now() + Math.max(0, delayMs));
  }

  stop(): void {
    this.stopped = true;
    this.disarm();
    this.pendingArmAtMs = null;
  }

  getMetrics(): HeartbeatSweepSchedulerMetrics {
    return {
      sweeps: this.sweeps,
      arms: this.arms,
      coalescedRequests: this.coalescedRequests,
      sweepErrors: this.sweepErrors,
      armedAtMs: this.armedAtMs,
    };
  }

  private armAt(atMs: number): void {
    if (this.stopped) return;
    if (this.running) {
      // The in-flight sweep rearms when it finishes; fold this deadline in
      // rather than racing it with a second timer.
      this.pendingArmAtMs = earliestDueAt(this.pendingArmAtMs, atMs);
      return;
    }
    if (this.armedAtMs !== null && this.armedAtMs <= atMs) {
      this.coalescedRequests += 1;
      return;
    }
    this.disarm();
    const delayMs = Math.min(
      this.maxDelayMs,
      Math.max(this.minDelayMs, atMs - this.now()),
    );
    this.armedAtMs = this.now() + delayMs;
    this.arms += 1;
    this.handle = this.armTimer(() => {
      this.handle = null;
      this.armedAtMs = null;
      void this.runSweep();
    }, delayMs);
  }

  private disarm(): void {
    this.handle?.cancel();
    this.handle = null;
    this.armedAtMs = null;
  }

  private async runSweep(): Promise<void> {
    if (this.stopped || this.running) return;
    this.running = true;
    let dueAtMs: number | null = null;
    try {
      this.sweeps += 1;
      dueAtMs = await this.sweep(this.now());
    } catch {
      this.sweepErrors += 1;
      dueAtMs = this.now() + this.errorRetryMs;
    } finally {
      this.running = false;
      const pending = this.pendingArmAtMs;
      this.pendingArmAtMs = null;
      const next = earliestDueAt(dueAtMs, pending);
      if (next !== null) this.armAt(next);
    }
  }
}
