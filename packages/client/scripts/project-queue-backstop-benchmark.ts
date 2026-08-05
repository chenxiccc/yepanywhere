/**
 * Measures the cost of Project Queue's missed-event backstop before and after
 * it became one deadline-aware owner per source (client query controller plan,
 * step 11).
 *
 * Both arms keep the queue current: whenever the server says something could
 * happen — a quiet window elapsing, a scheduled retry — the client has re-read
 * by then. They differ in how much they read while nothing can happen.
 *
 * Arm A models the removed per-consumer `setInterval(refetch, 5000)`, which ran
 * whenever any queue item or recovered session queue existed, regardless of
 * whether the project was waiting, blocked, or paused. Arm B is the shipped
 * rule from `src/hooks/useProjectQueues.ts`: honour the server's reported
 * `nextAttemptAt`/`quietEligibleAt`, fall back to five seconds only while a
 * project is `ready` or `dispatching`, and arm nothing at all otherwise.
 */
import { performance } from "node:perf_hooks";

/** Mounted `useProjectQueues()` consumers: Sidebar, Projects, New Session, … */
const CONSUMERS = 4;
const SESSION_MS = 10 * 60 * 1000;
const ACTIVE_FALLBACK_MS = 5000;

type QueueState =
  | "waiting-quiet"
  | "blocked"
  | "paused"
  | "ready"
  | "dispatching";

interface Phase {
  state: QueueState;
  durationMs: number;
  /** Set when the server reports the exact instant it will next act. */
  reportsDeadline: boolean;
}

/**
 * Ten minutes of an ordinary backlog: quiet windows the server has already
 * timed, stretches blocked behind a running turn, a pause, and short bursts of
 * actual dispatching. Only the last of these can surprise the client.
 */
const PHASES: Phase[] = [
  { state: "waiting-quiet", durationMs: 30_000, reportsDeadline: true },
  { state: "dispatching", durationMs: 8_000, reportsDeadline: false },
  { state: "blocked", durationMs: 120_000, reportsDeadline: false },
  { state: "waiting-quiet", durationMs: 30_000, reportsDeadline: true },
  { state: "ready", durationMs: 4_000, reportsDeadline: false },
  { state: "blocked", durationMs: 90_000, reportsDeadline: false },
  { state: "paused", durationMs: 150_000, reportsDeadline: false },
  { state: "waiting-quiet", durationMs: 30_000, reportsDeadline: true },
  { state: "dispatching", durationMs: 6_000, reportsDeadline: false },
  { state: "blocked", durationMs: 132_000, reportsDeadline: false },
];

interface ArmResult {
  fetches: number;
  timersArmed: number;
  /** Deadlines the server reported that the client read at or before. */
  deadlinesMet: number;
  durationMs: number;
}

interface PhaseWindow extends Phase {
  startMs: number;
  endMs: number;
}

function phaseWindows(): PhaseWindow[] {
  const windows: PhaseWindow[] = [];
  let atMs = 0;
  for (const phase of PHASES) {
    windows.push({ ...phase, startMs: atMs, endMs: atMs + phase.durationMs });
    atMs += phase.durationMs;
  }
  return windows;
}

/** Deadlines the client must not sleep through: each timed quiet window's end. */
function reportedDeadlines(windows: readonly PhaseWindow[]): number[] {
  return windows.filter((w) => w.reportsDeadline).map((w) => w.endMs);
}

function countMet(
  deadlines: readonly number[],
  reads: readonly number[],
): number {
  return deadlines.filter((deadline) =>
    reads.some(
      (readAtMs) => readAtMs >= deadline && readAtMs <= deadline + 1000,
    ),
  ).length;
}

/** Arm A — one five-second interval per mounted consumer, always running. */
function measurePrevious(windows: readonly PhaseWindow[]): ArmResult {
  const startedAt = performance.now();
  const reads: number[] = [];
  let timersArmed = 0;

  for (let consumer = 0; consumer < CONSUMERS; consumer += 1) {
    timersArmed += 1; // one interval, armed for the whole session
    for (
      let atMs = ACTIVE_FALLBACK_MS;
      atMs <= SESSION_MS;
      atMs += ACTIVE_FALLBACK_MS
    ) {
      reads.push(atMs);
    }
  }

  return {
    fetches: reads.length,
    timersArmed,
    deadlinesMet: countMet(reportedDeadlines(windows), reads),
    durationMs: performance.now() - startedAt,
  };
}

/** Arm B — one owner per source, armed for the earliest thing that can happen. */
function measureRetained(windows: readonly PhaseWindow[]): ArmResult {
  const startedAt = performance.now();
  const reads: number[] = [];
  let timersArmed = 0;

  const phaseAt = (atMs: number): PhaseWindow | undefined =>
    windows.find((w) => atMs >= w.startMs && atMs < w.endMs);

  let nowMs = 0;
  while (nowMs < SESSION_MS) {
    const phase = phaseAt(nowMs);
    if (!phase) break;

    let firesAtMs: number | null = phase.reportsDeadline ? phase.endMs : null;
    if (phase.state === "ready" || phase.state === "dispatching") {
      const fallbackAtMs = nowMs + ACTIVE_FALLBACK_MS;
      firesAtMs =
        firesAtMs === null ? fallbackAtMs : Math.min(firesAtMs, fallbackAtMs);
    }

    if (firesAtMs === null) {
      // Nothing scheduled and nothing in flight: events own the transition, so
      // no timer is armed. Advance to the next phase, which an event delivers.
      nowMs = phase.endMs;
      continue;
    }

    timersArmed += 1;
    nowMs = firesAtMs;
    if (nowMs <= SESSION_MS) reads.push(nowMs);
  }

  return {
    fetches: reads.length,
    timersArmed,
    deadlinesMet: countMet(reportedDeadlines(windows), reads),
    durationMs: performance.now() - startedAt,
  };
}

function percentAvoided(before: number, after: number): string {
  if (before === 0) return "0.00%";
  return `${(((before - after) / before) * 100).toFixed(2)}%`;
}

function ratio(before: number, after: number): string {
  if (after === 0) return "all avoided";
  return `${(before / after).toFixed(2)}x`;
}

function main(): void {
  const windows = phaseWindows();
  const deadlines = reportedDeadlines(windows);
  const previous = measurePrevious(windows);
  const retained = measureRetained(windows);

  console.log(
    `${CONSUMERS} mounted consumers, ${SESSION_MS / 1000}s of backlog, ` +
      `${deadlines.length} server-reported deadlines`,
  );
  console.log("");
  console.log(
    `/api/project-queue reads: ${previous.fetches} -> ${retained.fetches} ` +
      `(${percentAvoided(previous.fetches, retained.fetches)} avoided, ` +
      `${ratio(previous.fetches, retained.fetches)})`,
  );
  console.log(
    `timers:                  ${previous.timersArmed} repeating intervals -> ` +
      `${retained.timersArmed} one-shot deadlines`,
  );
  console.log(
    `reported deadlines met:  ${previous.deadlinesMet} -> ${retained.deadlinesMet} ` +
      `of ${deadlines.length} (read within 1s of the instant the server named)`,
  );

  // The comparison only counts if the cheaper arm is still current.
  if (retained.deadlinesMet < previous.deadlinesMet) {
    throw new Error(
      `retained backstop missed a deadline the interval met: ` +
        `${previous.deadlinesMet} -> ${retained.deadlinesMet}`,
    );
  }
  if (retained.deadlinesMet !== deadlines.length) {
    throw new Error(
      `retained backstop met ${retained.deadlinesMet} of ${deadlines.length} deadlines`,
    );
  }
  if (previous.fetches <= retained.fetches) {
    throw new Error(
      `expected fewer reads, got ${previous.fetches} -> ${retained.fetches}`,
    );
  }
}

main();
