/**
 * Measures the client-side cost of `useVersion()` before and after the
 * source-keyed retained snapshot (client query controller plan, step 9).
 *
 * The two arms deliver the same outcome: every one of the app's version
 * consumers ends holding a resolved snapshot, and a server that advertises a
 * still-validating speech backend is re-read until it settles. They differ only
 * in who owns the request and the follow-up timer.
 *
 * Arm B drives the real `ensureClientQuery` from
 * `src/lib/clientQueryController.ts`, so its dedupe is the shipped logic rather
 * than a restatement of it. Arm A models the previous hook, whose only sharing
 * was a module-level promise held while a request was in flight. The React
 * layer (mount effect, 500 ms revalidation debounce) is modelled in both arms.
 */
import { performance } from "node:perf_hooks";
import {
  type ClientQuerySettlement,
  createClientQueryKey,
  ensureClientQuery,
  resetClientQueryControllerForTests,
} from "../src/lib/clientQueryController.js";
import { asClientSummarySourceKey } from "../src/lib/clientSummaryStore.js";

/** Observed on the live development server: 45 ms to 680 ms per response. */
const MIN_LATENCY_MS = 45;
const MAX_LATENCY_MS = 680;
/** 989 kB of logical server reads across 20 observed calls. */
const RESPONSE_BYTES = 49_450;
/** The hook's existing retry cadence while a speech backend is validating. */
const PENDING_RETRY_MS = 1000;
/** How long a restarted server keeps reporting `validationStatus: "pending"`. */
const PENDING_WINDOW_MS = 3000;

const SOURCE = asClientSummarySourceKey("host:benchmark");
const VERSION_QUERY_KEY = createClientQueryKey({ endpoint: "version" });

/**
 * When each of the 34 `useVersion()` consumers mounts, in ms from app start.
 * The app shell, sidebar, and composer mount together; the rest arrive as the
 * user opens routes and settings panes. Sequential mounts are exactly where the
 * previous shape re-requested, because its sharing ended when the request did.
 */
const CONSUMER_MOUNT_MS = [
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 900, 1400, 2600, 3300, 4100, 5200, 6800,
  8100, 9500, 11200, 13000, 15500, 18000, 21000, 24500, 28000, 32000, 36500,
  41000, 46000, 52000, 58000,
];

/** Deterministic latencies so repeated runs are comparable. */
function latencyFor(requestIndex: number): number {
  const span = MAX_LATENCY_MS - MIN_LATENCY_MS;
  // A cheap fixed sequence; no dependence on Math.random.
  const spread = (requestIndex * 2654435761) % (span + 1);
  return MIN_LATENCY_MS + spread;
}

interface ArmResult {
  requests: number;
  bytes: number;
  timersArmed: number;
  /** Total ms consumers spent waiting for their first resolved snapshot. */
  totalWaitMs: number;
  /** Consumers that had to wait for a network response at all. */
  consumersThatWaited: number;
  /** Every consumer ended holding a snapshot. */
  consumersResolved: number;
  /** Validation was followed until it settled, rather than abandoned. */
  settled: boolean;
  durationMs: number;
}

interface ScheduledResolution {
  atMs: number;
  resolve: () => void;
}

/** A virtual clock so response latency does not cost real wall-clock time. */
class VirtualClock {
  nowMs = 0;
  private pending: ScheduledResolution[] = [];

  scheduleAt(atMs: number, resolve: () => void): void {
    this.pending.push({ atMs, resolve });
  }

  hasWork(): boolean {
    return this.pending.length > 0;
  }

  /** Advance to the next scheduled instant and fire everything due there. */
  async advance(): Promise<void> {
    if (this.pending.length === 0) return;
    const nextMs = Math.min(...this.pending.map((entry) => entry.atMs));
    this.nowMs = nextMs;
    const due = this.pending.filter((entry) => entry.atMs === nextMs);
    this.pending = this.pending.filter((entry) => entry.atMs !== nextMs);
    for (const entry of due) entry.resolve();
    // Let every promise chain woken by these resolutions run to completion.
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }
}

interface VersionPayload {
  current: string;
  pendingSpeechBackend: boolean;
}

/** The shared server stub. Both arms pay the same per-request cost. */
class VersionServer {
  requests = 0;
  bytes = 0;

  constructor(private readonly clock: VirtualClock) {}

  request(): Promise<VersionPayload> {
    const requestIndex = this.requests;
    this.requests += 1;
    this.bytes += RESPONSE_BYTES;
    const startedAt = this.clock.nowMs;
    const resolvesAt = startedAt + latencyFor(requestIndex);
    return new Promise<VersionPayload>((resolve) => {
      this.clock.scheduleAt(resolvesAt, () => {
        resolve({
          current: "1.0.0",
          pendingSpeechBackend: resolvesAt < PENDING_WINDOW_MS,
        });
      });
    });
  }
}

/**
 * Arm A — the previous hook. `sharedVersionRequest` joins only callers that
 * arrive while a request is open, so each later mount starts its own; and every
 * mounted consumer whose snapshot is pending arms its own retry timer.
 */
async function measurePrevious(): Promise<ArmResult> {
  const startedAt = performance.now();
  const clock = new VirtualClock();
  const server = new VersionServer(clock);
  let timersArmed = 0;
  let totalWaitMs = 0;
  let consumersThatWaited = 0;

  let consumersResolved = 0;
  let settled = false;

  let sharedRequest: Promise<VersionPayload> | null = null;
  const requestVersion = async (): Promise<VersionPayload> => {
    let pending = sharedRequest;
    if (!pending) {
      const request = server.request().finally(() => {
        if (sharedRequest === request) sharedRequest = null;
      });
      sharedRequest = request;
      pending = request;
    }
    const payload = await pending;
    settled = !payload.pendingSpeechBackend;
    return payload;
  };

  const consumerWork: Promise<void>[] = [];
  const mountConsumer = (mountAtMs: number): void => {
    consumerWork.push(
      (async () => {
        await new Promise<void>((resolve) => {
          clock.scheduleAt(mountAtMs, resolve);
        });

        // Every consumer owns its initial request; nothing retains a result.
        const requestedAt = clock.nowMs;
        consumersThatWaited += 1;
        let payload = await requestVersion();
        totalWaitMs += clock.nowMs - requestedAt;

        // Every consumer owns its own pending-validation timer.
        while (payload.pendingSpeechBackend) {
          timersArmed += 1;
          const firesAt = clock.nowMs + PENDING_RETRY_MS;
          await new Promise<void>((resolve) => {
            clock.scheduleAt(firesAt, resolve);
          });
          payload = await requestVersion();
        }
        consumersResolved += 1;
      })(),
    );
  };

  for (const mountAtMs of CONSUMER_MOUNT_MS) mountConsumer(mountAtMs);

  while (clock.hasWork()) await clock.advance();
  await Promise.all(consumerWork);

  return {
    requests: server.requests,
    bytes: server.bytes,
    timersArmed,
    totalWaitMs,
    consumersThatWaited,
    consumersResolved,
    settled,
    durationMs: performance.now() - startedAt,
  };
}

/**
 * Arm B — the retained snapshot. One `ensureClientQuery` entry per source
 * answers every later mount without network work, and one follow-up owner
 * re-reads the snapshot while a speech backend is validating.
 */
async function measureRetained(): Promise<ArmResult> {
  const startedAt = performance.now();
  resetClientQueryControllerForTests();
  const clock = new VirtualClock();
  const server = new VersionServer(clock);
  let timersArmed = 0;
  let totalWaitMs = 0;
  let consumersThatWaited = 0;
  let consumersResolved = 0;

  let settled = false;
  const ensureVersion = (force: boolean): Promise<ClientQuerySettlement> =>
    ensureClientQuery({
      sourceKey: SOURCE,
      key: VERSION_QUERY_KEY,
      force,
      fetcher: () => server.request(),
      applySnapshot: (payload: VersionPayload) => {
        settled = !payload.pendingSpeechBackend;
      },
    });

  // One source-level follow-up owner, retained while any consumer is mounted.
  let retainedConsumers = 0;
  const runFollowUp = async (): Promise<void> => {
    while (retainedConsumers > 0 && !settled) {
      timersArmed += 1;
      const firesAt = clock.nowMs + PENDING_RETRY_MS;
      await new Promise<void>((resolve) => {
        clock.scheduleAt(firesAt, resolve);
      });
      await ensureVersion(true);
    }
  };
  let followUpRunning = false;

  const consumerWork: Promise<void>[] = [];
  const mountConsumer = (mountAtMs: number): void => {
    consumerWork.push(
      (async () => {
        await new Promise<void>((resolve) => {
          clock.scheduleAt(mountAtMs, resolve);
        });
        retainedConsumers += 1;

        const requestedAt = clock.nowMs;
        const requestsBefore = server.requests;
        await ensureVersion(false);
        if (server.requests > requestsBefore || clock.nowMs > requestedAt) {
          consumersThatWaited += 1;
          totalWaitMs += clock.nowMs - requestedAt;
        }

        if (!followUpRunning) {
          followUpRunning = true;
          await runFollowUp();
          followUpRunning = false;
        }
        consumersResolved += 1;
      })(),
    );
  };

  for (const mountAtMs of CONSUMER_MOUNT_MS) mountConsumer(mountAtMs);

  while (clock.hasWork()) await clock.advance();
  await Promise.all(consumerWork);

  return {
    requests: server.requests,
    bytes: server.bytes,
    timersArmed,
    totalWaitMs,
    consumersThatWaited,
    consumersResolved,
    settled,
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

async function main(): Promise<void> {
  const previous = await measurePrevious();
  const retained = await measureRetained();

  const consumers = CONSUMER_MOUNT_MS.length;
  console.log(`useVersion consumers: ${consumers}`);
  console.log(
    `mount span: 0 ms to ${CONSUMER_MOUNT_MS[CONSUMER_MOUNT_MS.length - 1]} ms; ` +
      `speech validation pending for the first ${PENDING_WINDOW_MS} ms`,
  );
  console.log("");
  console.log(
    `requests:            ${previous.requests} -> ${retained.requests} ` +
      `(${percentAvoided(previous.requests, retained.requests)} avoided, ` +
      `${ratio(previous.requests, retained.requests)})`,
  );
  console.log(
    `response bytes:      ${(previous.bytes / 1024).toFixed(1)} kB -> ` +
      `${(retained.bytes / 1024).toFixed(1)} kB`,
  );
  console.log(
    `pending-retry timers:${" "}${previous.timersArmed} -> ${retained.timersArmed} ` +
      `(${ratio(previous.timersArmed, retained.timersArmed)})`,
  );
  console.log(
    `consumers that waited for a response: ${previous.consumersThatWaited} -> ` +
      `${retained.consumersThatWaited} of ${consumers}`,
  );
  console.log(
    `total consumer wait: ${previous.totalWaitMs} ms -> ${retained.totalWaitMs} ms ` +
      `(${ratio(previous.totalWaitMs, retained.totalWaitMs)})`,
  );

  // The comparison is only meaningful if both arms did the same job.
  for (const [name, arm] of [
    ["previous", previous],
    ["retained", retained],
  ] as const) {
    if (arm.consumersResolved !== consumers) {
      throw new Error(
        `${name} arm resolved ${arm.consumersResolved} of ${consumers} consumers`,
      );
    }
    if (!arm.settled) {
      throw new Error(`${name} arm abandoned speech validation while pending`);
    }
  }
  if (previous.requests <= retained.requests) {
    throw new Error(
      `expected the retained snapshot to issue fewer requests, got ` +
        `${previous.requests} -> ${retained.requests}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
