import { describe, expect, it } from "vitest";
import {
  HeartbeatSweepScheduler,
  earliestDueAt,
} from "../../src/supervisor/heartbeatSchedule.js";

/**
 * A virtual clock with one pending-timer list, so a test can assert exactly
 * when the scheduler chose to wake up instead of waiting for real time.
 */
function clock(startMs = 1_000_000) {
  let nowMs = startMs;
  let nextId = 0;
  const timers = new Map<number, { atMs: number; fire: () => void }>();
  return {
    now: () => nowMs,
    arm: (fire: () => void, delayMs: number) => {
      const id = nextId++;
      timers.set(id, { atMs: nowMs + delayMs, fire });
      return { cancel: () => timers.delete(id) };
    },
    /** Instant the soonest armed timer fires, or null when nothing is armed. */
    nextAtMs(): number | null {
      let earliest: number | null = null;
      for (const timer of timers.values()) {
        earliest = earliestDueAt(earliest, timer.atMs);
      }
      return earliest;
    },
    armedCount: () => timers.size,
    /** Advance to the next armed timer and fire it. */
    async advanceToNext(): Promise<void> {
      const atMs = this.nextAtMs();
      if (atMs === null) throw new Error("no timer armed");
      nowMs = Math.max(nowMs, atMs);
      // Collect before firing: a fired timer may arm the next one, and adding
      // to a Map mid-iteration would visit it in the same pass.
      const due: Array<() => void> = [];
      for (const [id, timer] of timers) {
        if (timer.atMs > nowMs) continue;
        timers.delete(id);
        due.push(timer.fire);
      }
      for (const fire of due) fire();
      await Promise.resolve();
      await Promise.resolve();
    },
    advanceBy(ms: number) {
      nowMs += ms;
    },
  };
}

describe("earliestDueAt", () => {
  it("treats null as no deadline", () => {
    expect(earliestDueAt(null, null)).toBeNull();
    expect(earliestDueAt(5, null)).toBe(5);
    expect(earliestDueAt(null, 5)).toBe(5);
    expect(earliestDueAt(9, 5)).toBe(5);
  });
});

describe("HeartbeatSweepScheduler", () => {
  it("arms nothing once every source reports no deadline", async () => {
    const time = clock();
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => null,
      now: time.now,
      arm: time.arm,
    });

    scheduler.requestSweepWithin(30_000);
    expect(time.nextAtMs()).toBe(time.now() + 30_000);

    await time.advanceToNext();
    expect(scheduler.getMetrics().sweeps).toBe(1);
    expect(time.armedCount()).toBe(0);
    expect(scheduler.getMetrics().armedAtMs).toBeNull();
  });

  it("wakes at the reported deadline rather than on an interval", async () => {
    const time = clock();
    const deadlines = [time.now() + 300_000, null];
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => deadlines.shift() ?? null,
      now: time.now,
      arm: time.arm,
    });

    scheduler.requestSweepWithin(0);
    await time.advanceToNext();

    // One sweep, and the next wake is five minutes out, not thirty seconds.
    expect(scheduler.getMetrics().sweeps).toBe(1);
    expect(time.nextAtMs()).toBe(1_000_000 + 300_000);
  });

  it("keeps the sooner of an armed timer and a new request", async () => {
    const time = clock();
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => null,
      now: time.now,
      arm: time.arm,
    });

    scheduler.requestSweepWithin(300_000);
    scheduler.requestSweepWithin(30_000);
    expect(time.nextAtMs()).toBe(time.now() + 30_000);
    expect(scheduler.getMetrics().arms).toBe(2);

    // A later request is absorbed by the timer already armed for sooner.
    scheduler.requestSweepWithin(120_000);
    expect(time.nextAtMs()).toBe(time.now() + 30_000);
    expect(scheduler.getMetrics().coalescedRequests).toBe(1);
    expect(time.armedCount()).toBe(1);
  });

  it("folds a request made during a sweep into the post-sweep deadline", async () => {
    const time = clock();
    const held: { release: () => void } = { release: () => {} };
    const inSweep = new Promise<void>((resolve) => {
      held.release = resolve;
    });
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => {
        await inSweep;
        return time.now() + 300_000;
      },
      now: time.now,
      arm: time.arm,
    });

    scheduler.requestSweepWithin(0);
    await time.advanceToNext();

    // Arrives mid-sweep and must not race a second timer against the result.
    scheduler.requestSweepWithin(30_000);
    expect(scheduler.isArmedWithin(0)).toBe(true);
    expect(time.armedCount()).toBe(0);

    held.release();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(time.armedCount()).toBe(1);
    expect(time.nextAtMs()).toBe(time.now() + 30_000);
  });

  it("rearms after a sweep throws so one failure cannot disarm heartbeats", async () => {
    const time = clock();
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => {
        throw new Error("candidate lookup failed");
      },
      now: time.now,
      arm: time.arm,
      errorRetryMs: 30_000,
    });

    scheduler.requestSweepWithin(0);
    await time.advanceToNext();

    expect(scheduler.getMetrics().sweepErrors).toBe(1);
    expect(time.nextAtMs()).toBe(time.now() + 30_000);
  });

  it("holds a due-now deadline to the minimum delay instead of spinning", async () => {
    const time = clock();
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => time.now() - 5_000,
      now: time.now,
      arm: time.arm,
      minDelayMs: 250,
    });

    scheduler.requestSweepWithin(0);
    await time.advanceToNext();
    expect(time.nextAtMs()).toBe(time.now() + 250);
  });

  it("stops arming once stopped", async () => {
    const time = clock();
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => time.now() + 1_000,
      now: time.now,
      arm: time.arm,
    });

    scheduler.requestSweepWithin(0);
    await time.advanceToNext();
    expect(time.armedCount()).toBe(1);

    scheduler.stop();
    expect(time.armedCount()).toBe(0);
    scheduler.requestSweepWithin(0);
    expect(time.armedCount()).toBe(0);
  });
});

/**
 * Tactical 098 step 6's adverse states for this module: the host clock is not
 * a reliable narrator. A laptop suspends past a deadline, an NTP correction
 * moves it either way, and a deadline reconstructed from a stored anchor after
 * restart can name an instant this clock disagrees with.
 */
describe("HeartbeatSweepScheduler under clock and sleep faults", () => {
  it("sweeps once after the host sleeps past several deadlines", async () => {
    const time = clock();
    let sweeps = 0;
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => {
        sweeps += 1;
        return time.now() + 60_000;
      },
      now: time.now,
      arm: time.arm,
    });

    scheduler.requestSweepWithin(60_000);
    // The lid closes for an hour. A fixed interval would have queued sixty
    // ticks; a deadline names one instant, however far past it the host wakes.
    time.advanceBy(60 * 60_000);
    await time.advanceToNext();

    expect(sweeps).toBe(1);
    expect(time.armedCount()).toBe(1);
  });

  it("bounds a deadline the clock puts absurdly far away", async () => {
    const time = clock();
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => null,
      now: time.now,
      arm: time.arm,
      maxDelayMs: 60_000,
    });

    // A stored anchor read under a skewed clock, or a clock corrected
    // backwards after the deadline was computed.
    scheduler.requestSweepWithin(365 * 24 * 60 * 60_000);

    const armedAt = time.nextAtMs();
    expect(armedAt).not.toBeNull();
    expect((armedAt as number) - time.now()).toBe(60_000);
  });

  it("coalesces onto a timer the clock has already moved past", async () => {
    const time = clock();
    let sweeps = 0;
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => {
        sweeps += 1;
        return null;
      },
      now: time.now,
      arm: time.arm,
      minDelayMs: 250,
    });

    scheduler.requestSweepWithin(10_000);
    // The clock jumps forward past the armed instant. That timer is already
    // due — a host timer armed for 10 s ago has fired — so a new request must
    // fold into it rather than arming a second one that would sweep twice.
    time.advanceBy(30_000);
    scheduler.requestSweepWithin(0);

    expect(time.armedCount()).toBe(1);
    expect(scheduler.getMetrics().coalescedRequests).toBe(1);
    expect(scheduler.getMetrics().arms).toBe(1);

    await time.advanceToNext();
    expect(sweeps).toBe(1);
  });

  it("does not rearm when stopped during a sweep", async () => {
    const time = clock();
    let release: (() => void) | null = null;
    const scheduler = new HeartbeatSweepScheduler({
      sweep: async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return time.now() + 1_000;
      },
      now: time.now,
      arm: time.arm,
    });

    scheduler.requestSweepWithin(0);
    await time.advanceToNext();
    expect(release).not.toBeNull();

    // Shutdown lands while the sweep is open; its post-sweep rearm must not
    // resurrect the timer.
    scheduler.stop();
    (release as unknown as () => void)();
    await Promise.resolve();
    await Promise.resolve();

    expect(time.armedCount()).toBe(0);
  });

  it("does not rearm when stopped while a sweep is failing", async () => {
    const time = clock();
    let release: ((error: Error) => void) | null = null;
    const scheduler = new HeartbeatSweepScheduler({
      sweep: () =>
        new Promise<number | null>((_resolve, reject) => {
          release = reject;
        }),
      now: time.now,
      arm: time.arm,
    });

    scheduler.requestSweepWithin(0);
    await time.advanceToNext();

    scheduler.stop();
    (release as unknown as (error: Error) => void)(new Error("catalog gone"));
    await Promise.resolve();
    await Promise.resolve();

    expect(time.armedCount()).toBe(0);
    expect(scheduler.getMetrics().sweepErrors).toBe(1);
  });
});
