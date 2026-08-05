/**
 * Measures the app shell's global-sessions feeds before and after they got one
 * mount per query key and one revalidation owner per key.
 *
 * `useGlobalSessionsFeed` never joined the revalidation-owner migration, so
 * every mounted feed carried its own reconnect listener and its own debounce
 * timer. The sidebar made that worse by mounting the pair twice — once in the
 * layout to retain coverage across the overlay's unmounts, once in the
 * component to read it.
 *
 * Arm B drives the real `retainQueryRevalidation` and the real `activityBus`.
 * Arm A models the previous shape, including its in-flight join rule: a forced
 * refetch joins an open request only when that request's coverage already
 * satisfies it, so a wider consumer mounted after a narrower one issues its own.
 */
import { performance } from "node:perf_hooks";
import { activityBus, type ActivityEventType } from "../src/lib/activityBus.js";
import {
  getQueryRevalidationMetrics,
  resetQueryRevalidationForTests,
  retainQueryRevalidation,
} from "../src/lib/clientQueryRevalidation.js";
import { asClientSummarySourceKey } from "../src/lib/clientSummaryStore.js";

const SOURCE = asClientSummarySourceKey("host:benchmark");
const DEBOUNCE_MS = 500;
const GLOBAL_KEY = "global-sessions";
const STARRED_KEY = "global-sessions:starred";

interface FeedMount {
  what: string;
  key: string;
  /** Rows this mount needs — the coverage its refetch would request. */
  minRows: number;
  /** Removed by the provider: the layout no longer mounts a second pair. */
  onlyPrevious?: boolean;
}

/** A desktop tab sitting on the Global Sessions page with the sidebar open. */
const MOUNTS: FeedMount[] = [
  {
    what: "layout retainer (global)",
    key: GLOBAL_KEY,
    minRows: 50,
    onlyPrevious: true,
  },
  {
    what: "layout retainer (starred)",
    key: STARRED_KEY,
    minRows: 50,
    onlyPrevious: true,
  },
  { what: "Sidebar (global)", key: GLOBAL_KEY, minRows: 50 },
  { what: "Sidebar (starred)", key: STARRED_KEY, minRows: 50 },
  { what: "Global Sessions page", key: GLOBAL_KEY, minRows: 100 },
  { what: "recent-sessions dropdown", key: GLOBAL_KEY, minRows: 15 },
];

/** Reconnects plus ordinary traffic that makes the feeds revalidate. */
const RECONNECTS = 6;

interface ArmResult {
  mounts: number;
  reconnectListeners: number;
  timersArmed: number;
  refetchRequests: number;
  durationMs: number;
}

/**
 * How many requests one reconnect costs a set of mounts sharing a key, under
 * the controller's join rule: each mount forces in mount order, and joins an
 * open request only when that request's coverage already covers it.
 */
function previousRequestsPerReconnect(minRowsInMountOrder: number[]): number {
  let requests = 0;
  let openCoverage = -1;
  for (const minRows of minRowsInMountOrder) {
    if (minRows <= openCoverage) continue;
    requests += 1;
    openCoverage = Math.max(openCoverage, minRows);
  }
  return requests;
}

/** Arm A — one listener, one timer, and one forced fetch per mounted feed. */
function measurePrevious(): ArmResult {
  const startedAt = performance.now();
  const mounts = MOUNTS;
  const byKey = new Map<string, number[]>();
  for (const mount of mounts) {
    byKey.set(mount.key, [...(byKey.get(mount.key) ?? []), mount.minRows]);
  }

  let refetchRequests = 0;
  for (const minRowsInMountOrder of byKey.values()) {
    refetchRequests += previousRequestsPerReconnect(minRowsInMountOrder);
  }

  return {
    mounts: mounts.length,
    reconnectListeners: mounts.length,
    timersArmed: mounts.length * RECONNECTS,
    refetchRequests: refetchRequests * RECONNECTS,
    durationMs: performance.now() - startedAt,
  };
}

/** Arm B — the real owner, with the layout's duplicate pair removed. */
async function measureRetained(): Promise<ArmResult> {
  const startedAt = performance.now();
  resetQueryRevalidationForTests();

  const mounts = MOUNTS.filter((mount) => !mount.onlyPrevious);
  const requestedRows: number[] = [];
  const handles = mounts.map((mount) =>
    retainQueryRevalidation({
      sourceKey: SOURCE,
      key: mount.key,
      subscriber: {
        coverage: { minRows: mount.minRows },
        events: ["reconnect"] as ActivityEventType[],
        debounceMs: DEBOUNCE_MS,
        run: () => {
          requestedRows.push(mount.minRows);
        },
      },
    }),
  );

  const reconnectListeners = getQueryRevalidationMetrics().eventSubscriptions;

  let timersArmed = 0;
  for (let index = 0; index < RECONNECTS; index += 1) {
    activityBus.emitLocal("reconnect", undefined as never);
    timersArmed += getQueryRevalidationMetrics().armedTimers;
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 20));
  }

  for (const handle of handles) handle.release();

  return {
    mounts: mounts.length,
    reconnectListeners,
    timersArmed,
    refetchRequests: requestedRows.length,
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

  console.log(
    `desktop tab on the Global Sessions page, sidebar open, ${RECONNECTS} reconnects`,
  );
  console.log("");
  console.log(
    `mounted feeds: ${previous.mounts} -> ${retained.mounts} ` +
      `(${percentAvoided(previous.mounts, retained.mounts)} avoided)`,
  );
  console.log(
    `reconnect listeners: ${previous.reconnectListeners} -> ${retained.reconnectListeners} ` +
      `(${ratio(previous.reconnectListeners, retained.reconnectListeners)})`,
  );
  console.log(
    `debounce timers armed: ${previous.timersArmed} -> ${retained.timersArmed} ` +
      `(${ratio(previous.timersArmed, retained.timersArmed)})`,
  );
  console.log(
    `refetch requests: ${previous.refetchRequests} -> ${retained.refetchRequests} ` +
      `(${percentAvoided(previous.refetchRequests, retained.refetchRequests)} avoided, ` +
      `${ratio(previous.refetchRequests, retained.refetchRequests)})`,
  );
  console.log("");
  console.log(
    "Note: the request figures count reconnect refetches only. Session-created, " +
      "metadata, and process-state events still reach each mount, but they now " +
      "coalesce into the owner's single timer instead of arming one apiece.",
  );

  // Both arms must still cover every key, with coverage no narrower than the
  // widest consumer of that key.
  const wanted = new Map<string, number>();
  for (const mount of MOUNTS) {
    wanted.set(mount.key, Math.max(wanted.get(mount.key) ?? 0, mount.minRows));
  }
  const perReconnect = retained.refetchRequests / RECONNECTS;
  if (perReconnect !== wanted.size) {
    throw new Error(
      `owner ran ${perReconnect} refetches per reconnect, expected one per key (${wanted.size})`,
    );
  }
  if (getQueryRevalidationMetrics().owners !== 0) {
    throw new Error("owners leaked after every handle was released");
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
