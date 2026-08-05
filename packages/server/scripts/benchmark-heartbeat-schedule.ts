import { performance } from "node:perf_hooks";
import {
  HeartbeatCandidateRegistry,
  type HeartbeatCandidateProject,
  type HeartbeatCandidateResolution,
} from "../src/services/HeartbeatCandidateRegistry.js";
import { HeartbeatSweepScheduler } from "../src/supervisor/heartbeatSchedule.js";
import { buildSessionLivenessSnapshot } from "../src/supervisor/liveness.js";

/**
 * One hour of a plausible install: a busy fleet of live sessions, a handful
 * opted into heartbeat turns, and one eligible unowned session whose
 * transcript has settled. Both arms perform identical per-sweep work — real
 * liveness snapshots and a real candidate registry generation — and both must
 * deliver the same heartbeats, so the measured difference is exactly the
 * number of wakeups each scheduler chose and how late each heartbeat was.
 */
const HOUR_MS = 60 * 60 * 1000;
const FIXED_TICK_MS = 30 * 1000;
const FALLBACK_RECHECK_MS = 30 * 1000;
const LIVE_SESSIONS = 200;
const ENABLED_SESSIONS = 3;
const ENABLED_AFTER_MS = 10 * 60 * 1000;
const CANDIDATE_AFTER_MS = 5 * 60 * 1000;
const PROJECTS = 10_000;
const START_MS = Date.parse("2026-08-05T00:00:00.000Z");
const WAITING_SESSION = "settled-unowned-session";

const projects: HeartbeatCandidateProject[] = Array.from(
  { length: PROJECTS },
  (_, index) => ({ id: `p${index}`, path: `/projects/p${index}` }),
);

interface Counters {
  sweeps: number;
  livenessSnapshots: number;
  candidateLookups: number;
  projectProbes: number;
  tailReads: number;
  heartbeats: number;
  /** Total ms each heartbeat landed after the instant it became due. */
  latenessMs: number;
}

interface Arm extends Counters {
  durationMs: number;
}

function newCounters(): Counters {
  return {
    sweeps: 0,
    livenessSnapshots: 0,
    candidateLookups: 0,
    projectProbes: 0,
    tailReads: 0,
    heartbeats: 0,
    latenessMs: 0,
  };
}

/** Idle anchors for the opted-in sessions, staggered so deadlines differ. */
function newAnchors(): number[] {
  return Array.from(
    { length: ENABLED_SESSIONS },
    (_, index) => START_MS - index * 37_000,
  );
}

/**
 * A settled eligible candidate: locatable in exactly one project, with a tail
 * that holds no pending tool call. It is the shape that used to be re-read on
 * every fixed tick.
 */
function makeRegistry(counters: Counters): HeartbeatCandidateRegistry {
  return new HeartbeatCandidateRegistry({
    listEligible: () => [[WAITING_SESSION, {}]],
    isOwned: () => false,
    listProjects: async () => projects,
    getProject: async (projectId) =>
      projects.find((project) => project.id === projectId),
    resolve: async (project): Promise<HeartbeatCandidateResolution | null> => {
      counters.projectProbes += 1;
      if (project.id !== "p6000") return null;
      const updatedAt = "2026-08-04T00:00:00.000Z";
      return {
        projectId: project.id,
        projectPath: project.path,
        provider: "codex",
        updatedAt,
        sourceVersion: `codex\0${updatedAt}`,
        readPendingToolCall: async () => {
          counters.tailReads += 1;
          return false;
        },
      };
    },
  });
}

/**
 * The per-sweep cost both arms pay: a liveness snapshot for every live
 * session, plus a candidate registry generation when the candidate half runs.
 * Fires any heartbeat whose quiet period has elapsed and reports the earliest
 * instant a source could next need attention.
 */
async function sweepOnce(
  nowMs: number,
  counters: Counters,
  anchors: number[],
  registry: HeartbeatCandidateRegistry,
  runCandidates: boolean,
): Promise<{ processDueAtMs: number; candidateDueAtMs: number | null }> {
  counters.sweeps += 1;
  const now = new Date(nowMs);
  let processDueAtMs = Number.POSITIVE_INFINITY;
  for (let index = 0; index < LIVE_SESSIONS; index += 1) {
    counters.livenessSnapshots += 1;
    const anchorMs = index < ENABLED_SESSIONS ? anchors[index] : START_MS;
    const snapshot = buildSessionLivenessSnapshot({
      provider: "claude",
      state: { type: "idle", since: new Date(anchorMs as number) },
      startedAt: new Date(anchorMs as number),
      lastStateChangeAt: new Date(anchorMs as number),
      lastProviderMessageAt: null,
      lastLivenessProbe: null,
      queueDepth: 0,
      deferredQueueDepth: 0,
      now,
    });
    if (index >= ENABLED_SESSIONS) continue;
    const idleSinceMs = Date.parse(snapshot.lastVerifiedIdleAt ?? "");
    const dueAtMs = idleSinceMs + ENABLED_AFTER_MS;
    if (nowMs >= dueAtMs) {
      counters.heartbeats += 1;
      counters.latenessMs += nowMs - dueAtMs;
      // The queued turn restarts the quiet period, exactly as a real one does.
      anchors[index] = nowMs;
      processDueAtMs = Math.min(processDueAtMs, nowMs + ENABLED_AFTER_MS);
      continue;
    }
    processDueAtMs = Math.min(processDueAtMs, dueAtMs);
  }

  let candidateDueAtMs: number | null = null;
  if (runCandidates) {
    counters.candidateLookups += 1;
    await registry.getCandidates();
    // A settled candidate cannot become due sooner than one idle threshold:
    // a pending tool call appearing now carries a transcript stamp of now.
    if (registry.getWaitingSessionIds().length > 0) {
      candidateDueAtMs = nowMs + CANDIDATE_AFTER_MS;
    }
  }
  return { processDueAtMs, candidateDueAtMs };
}

/** Today's shape: one fixed tick, candidate lookup included, forever. */
async function measureFixedTick(): Promise<Arm> {
  const counters = newCounters();
  const anchors = newAnchors();
  const registry = makeRegistry(counters);
  const startedAt = performance.now();
  for (
    let nowMs = START_MS;
    nowMs < START_MS + HOUR_MS;
    nowMs += FIXED_TICK_MS
  ) {
    await sweepOnce(nowMs, counters, anchors, registry, true);
  }
  return { ...counters, durationMs: performance.now() - startedAt };
}

/** The deadline scheduler, driven by a virtual clock over the same hour. */
async function measureDeadlines(): Promise<Arm> {
  const counters = newCounters();
  const anchors = newAnchors();
  const registry = makeRegistry(counters);
  let nowMs = START_MS;
  let nextId = 0;
  const timers = new Map<number, { atMs: number; fire: () => void }>();
  let candidateDueAtMs: number | null = START_MS;
  let sweepDone: Promise<unknown> = Promise.resolve();

  const scheduler = new HeartbeatSweepScheduler({
    now: () => nowMs,
    arm: (fire, delayMs) => {
      const id = nextId++;
      timers.set(id, { atMs: nowMs + delayMs, fire });
      return { cancel: () => timers.delete(id) };
    },
    errorRetryMs: FALLBACK_RECHECK_MS,
    sweep: (sweepNowMs) => {
      const runCandidates =
        candidateDueAtMs !== null && sweepNowMs >= candidateDueAtMs;
      const run = sweepOnce(
        sweepNowMs,
        counters,
        anchors,
        registry,
        runCandidates,
      ).then((result) => {
        if (runCandidates) candidateDueAtMs = result.candidateDueAtMs;
        const next = Math.min(
          result.processDueAtMs,
          candidateDueAtMs ?? Number.POSITIVE_INFINITY,
        );
        return Number.isFinite(next) ? next : null;
      });
      sweepDone = run;
      return run;
    },
  });

  const startedAt = performance.now();
  scheduler.requestSweepWithin(FALLBACK_RECHECK_MS);
  for (;;) {
    let earliest: number | null = null;
    for (const timer of timers.values()) {
      earliest =
        earliest === null ? timer.atMs : Math.min(earliest, timer.atMs);
    }
    if (earliest === null || earliest >= START_MS + HOUR_MS) break;
    nowMs = earliest;
    // Collect before firing: a fired timer may arm the next one, and adding to
    // a Map mid-iteration would visit it in the same pass.
    const due: Array<() => void> = [];
    for (const [id, timer] of timers) {
      if (timer.atMs > nowMs) continue;
      timers.delete(id);
      due.push(timer.fire);
    }
    for (const fire of due) fire();
    await sweepDone;
    for (let flush = 0; flush < 8; flush += 1) await Promise.resolve();
  }
  return { ...counters, durationMs: performance.now() - startedAt };
}

const fixed = await measureFixedTick();
const deadlines = await measureDeadlines();

if (deadlines.sweeps >= fixed.sweeps) {
  throw new Error(
    `Deadline scheduling swept ${deadlines.sweeps} times against ${fixed.sweeps} fixed ticks`,
  );
}
if (deadlines.heartbeats < fixed.heartbeats) {
  throw new Error(
    `Deadline scheduling delivered ${deadlines.heartbeats} heartbeats against ${fixed.heartbeats}`,
  );
}

const meanLateness = (arm: Arm) =>
  arm.heartbeats === 0 ? 0 : arm.latenessMs / arm.heartbeats;

console.log(
  [
    "HEARTBEAT_SCHEDULE:",
    "hours=1",
    `live_sessions=${LIVE_SESSIONS}`,
    `opted_in=${ENABLED_SESSIONS}`,
    `projects=${PROJECTS}`,
    `fixed_sweeps=${fixed.sweeps}`,
    `deadline_sweeps=${deadlines.sweeps}`,
    `avoided_sweeps_percent=${(
      100 * (1 - deadlines.sweeps / fixed.sweeps)
    ).toFixed(2)}`,
    `fixed_liveness_snapshots=${fixed.livenessSnapshots}`,
    `deadline_liveness_snapshots=${deadlines.livenessSnapshots}`,
    `fixed_candidate_lookups=${fixed.candidateLookups}`,
    `deadline_candidate_lookups=${deadlines.candidateLookups}`,
    `fixed_project_probes=${fixed.projectProbes}`,
    `deadline_project_probes=${deadlines.projectProbes}`,
    `fixed_tail_reads=${fixed.tailReads}`,
    `deadline_tail_reads=${deadlines.tailReads}`,
    `fixed_heartbeats=${fixed.heartbeats}`,
    `deadline_heartbeats=${deadlines.heartbeats}`,
    `fixed_mean_lateness_ms=${meanLateness(fixed).toFixed(0)}`,
    `deadline_mean_lateness_ms=${meanLateness(deadlines).toFixed(0)}`,
    `fixed_ms=${fixed.durationMs.toFixed(2)}`,
    `deadline_ms=${deadlines.durationMs.toFixed(2)}`,
    `speedup=${(fixed.durationMs / deadlines.durationMs).toFixed(2)}x`,
  ].join(" "),
);
