/**
 * Measures what a stranded stale flag costs a long session.
 *
 * Several mounted consumers of one query each invalidate and then force a
 * refetch when one activity event arrives. The first consumer's request is
 * shared, so the request count looked right — but every later consumer's
 * invalidation advanced the entry's generation past the one that request
 * settles against, so the entry stayed `stale` forever. A stale entry fails
 * `isFresh` unconditionally, so `staleTimeMs` stopped short-circuiting that
 * query for the rest of the session and every subsequent read became a request.
 *
 * Arm B drives the real `ensureClientQuery`. Arm A models the previous
 * bookkeeping: same shared refetch, but the entry never returns to fresh.
 *
 * `Date.now` is driven by an explicit clock so a ten-minute session with a
 * thirty-second stale time is measured exactly rather than slept through.
 */
import { performance } from "node:perf_hooks";
import {
  ensureClientQuery,
  getClientQueryState,
  invalidateClientQuery,
  resetClientQueryControllerForTests,
} from "../src/lib/clientQueryController.js";
import { asClientSummarySourceKey } from "../src/lib/clientSummaryStore.js";

const SOURCE = asClientSummarySourceKey("host:benchmark");
const QUERY_KEY = "global-sessions";
const COVERAGE = { minRows: 50 };
const STALE_TIME_MS = 30_000;

/** Sidebar's global feed: the navigation retainer plus each mounted Sidebar. */
const CONSUMERS = 4;
/** Ten minutes of a tab left open, read every fifteen seconds. */
const READ_INTERVAL_MS = 15_000;
const READS = 40;
/** One reconnect early in the session is all it takes to strand the flag. */
const RECONNECT_BEFORE_READ = 2;

const realNow = Date.now;
let clockMs = realNow();

function installClock(): void {
  clockMs = realNow();
  Date.now = () => clockMs;
}

function restoreClock(): void {
  Date.now = realNow;
}

interface ArmResult {
  requests: number;
  servedFromCache: number;
  endsStale: boolean;
  durationMs: number;
}

/**
 * Arm A — the previous bookkeeping. The reconnect's shared refetch happens the
 * same way, and then no read is ever served from cache again.
 */
function measurePrevious(): ArmResult {
  const startedAt = performance.now();
  let requests = 1; // the initial load
  let servedFromCache = 0;
  let stranded = false;

  for (let read = 0; read < READS; read += 1) {
    if (read === RECONNECT_BEFORE_READ) {
      requests += 1; // one shared refetch for the whole consumer set
      stranded = CONSUMERS > 1; // the extra invalidations advance past it
    }
    if (stranded) {
      requests += 1;
      continue;
    }
    servedFromCache += 1;
  }

  return {
    requests,
    servedFromCache,
    endsStale: stranded,
    durationMs: performance.now() - startedAt,
  };
}

/** Arm B — the real controller. */
async function measureRetained(): Promise<ArmResult> {
  const startedAt = performance.now();
  resetClientQueryControllerForTests();
  installClock();

  let requests = 0;
  const fetcher = async () => {
    requests += 1;
    return { rows: [] };
  };

  const read = () =>
    ensureClientQuery({
      sourceKey: SOURCE,
      key: QUERY_KEY,
      coverage: COVERAGE,
      staleTimeMs: STALE_TIME_MS,
      fetcher,
    });

  await read();

  let servedFromCache = 0;
  for (let index = 0; index < READS; index += 1) {
    if (index === RECONNECT_BEFORE_READ) {
      // Every mounted consumer reacts to the one reconnect.
      const refetches = Array.from({ length: CONSUMERS }, () => {
        invalidateClientQuery(SOURCE, QUERY_KEY);
        return ensureClientQuery({
          sourceKey: SOURCE,
          key: QUERY_KEY,
          coverage: COVERAGE,
          force: true,
          fetcher,
        });
      });
      await Promise.all(refetches);
    }

    const before = requests;
    await read();
    if (requests === before) servedFromCache += 1;
    clockMs += READ_INTERVAL_MS;
  }

  const endsStale = getClientQueryState(SOURCE, QUERY_KEY)?.stale === true;
  restoreClock();

  return {
    requests,
    servedFromCache,
    endsStale,
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
  const previous = measurePrevious();
  const retained = await measureRetained();

  const sessionMinutes = ((READS * READ_INTERVAL_MS) / 60_000).toFixed(0);
  console.log(
    `${CONSUMERS} consumers of one query, ${READS} reads over ${sessionMinutes} min ` +
      `at a ${STALE_TIME_MS / 1000}s stale time, one reconnect`,
  );
  console.log("");
  console.log(
    `requests: ${previous.requests} -> ${retained.requests} ` +
      `(${percentAvoided(previous.requests, retained.requests)} avoided, ` +
      `${ratio(previous.requests, retained.requests)})`,
  );
  console.log(
    `reads served from cache: ${previous.servedFromCache} -> ${retained.servedFromCache}`,
  );
  console.log(
    `entry left stale after the reconnect: ${previous.endsStale} -> ${retained.endsStale}`,
  );
  console.log("");
  console.log(
    "Note: the gain grows with session length, not with consumer count — one " +
      "reconnect with two or more consumers strands the flag, and every read " +
      "after it pays.",
  );

  if (retained.endsStale) {
    throw new Error(
      "entry is still stale after the forced refetch settled — the joined " +
        "force did not adopt the invalidation it raised",
    );
  }
  // Both arms must serve the same reads; only the request count may differ.
  const servedReads = retained.servedFromCache + (retained.requests - 2);
  if (servedReads !== READS) {
    throw new Error(
      `arm B served ${servedReads} of ${READS} reads — the arms are not doing equal work`,
    );
  }
}

main().catch((error: unknown) => {
  restoreClock();
  console.error(error);
  process.exit(1);
});
