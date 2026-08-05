/**
 * Measures the cost of retained-query revalidation before and after it became
 * one owner per `(sourceKey, queryKey)` (client query controller plan, step 11).
 *
 * Both arms revalidate on exactly the same events. They differ in how many
 * listeners and debounce timers the app installs to do it, and — because a
 * per-consumer debounce cannot coalesce once the first revalidation has already
 * completed — in how many requests one event costs.
 *
 * Arm B drives the real `retainQueryRevalidation` and the real `activityBus`,
 * so the owner's behavior here is the shipped behavior. Arm A models the
 * previous per-hook shape: one listener set and one timer per mounted consumer.
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

/**
 * The app shell's retained queries and how many components mount each. Sidebar
 * mounts its feeds from both the navigation retainer and the visual component,
 * and several routes each add a Project Queue and version consumer.
 */
const QUERIES: Array<{
  key: string;
  consumers: number;
  events: ActivityEventType[];
}> = [
  {
    key: "global-sessions",
    consumers: 4,
    events: ["refresh", "reconnect", "session-created"],
  },
  {
    key: "starred-sessions",
    consumers: 2,
    events: ["refresh", "reconnect", "session-metadata-changed"],
  },
  {
    key: "inbox",
    consumers: 2,
    events: ["refresh", "reconnect", "session-updated", "session-seen"],
  },
  {
    key: "processes",
    consumers: 3,
    events: ["refresh", "reconnect", "process-state-changed"],
  },
  { key: "projects", consumers: 3, events: ["refresh", "reconnect"] },
  {
    key: "project-queue",
    consumers: 4,
    events: ["refresh", "reconnect", "project-queue-changed"],
  },
  { key: "version", consumers: 5, events: ["reconnect"] },
  { key: "settings", consumers: 3, events: ["refresh", "reconnect"] },
];

/** One session's activity: wakes, reconnects, and ordinary session traffic. */
const EVENT_STREAM: ActivityEventType[] = [
  "reconnect",
  "session-updated",
  "process-state-changed",
  "refresh",
  "session-created",
  "reconnect",
  "session-updated",
  "project-queue-changed",
  "session-metadata-changed",
  "refresh",
  "session-seen",
  "process-state-changed",
  "reconnect",
  "session-updated",
  "refresh",
];

interface ArmResult {
  listeners: number;
  timersArmed: number;
  revalidationRuns: number;
  durationMs: number;
}

/**
 * Arm A — one listener set and one debounce timer per mounted consumer.
 *
 * Each consumer's timer produces its own revalidation. They coalesce only when
 * a prior request is still open when the next timer fires; with a response
 * faster than the gap between timer callbacks — the ordinary case for these
 * endpoints — there is nothing in flight to join, so the requests are separate.
 * That is the case modelled here, and it is the one the owner removes.
 */
function measurePrevious(): ArmResult {
  const startedAt = performance.now();
  let listeners = 0;
  let timersArmed = 0;
  let revalidationRuns = 0;

  for (const query of QUERIES) {
    listeners += query.consumers * query.events.length;
  }

  for (const eventType of EVENT_STREAM) {
    for (const query of QUERIES) {
      if (!query.events.includes(eventType)) continue;
      timersArmed += query.consumers;
      revalidationRuns += query.consumers;
    }
  }

  return {
    listeners,
    timersArmed,
    revalidationRuns,
    durationMs: performance.now() - startedAt,
  };
}

/** Arm B — the real owner: one listener set and one timer per query. */
async function measureRetained(): Promise<ArmResult> {
  const startedAt = performance.now();
  resetQueryRevalidationForTests();

  let revalidationRuns = 0;
  let timersArmed = 0;
  const handles = QUERIES.flatMap((query) =>
    Array.from({ length: query.consumers }, () =>
      retainQueryRevalidation({
        sourceKey: SOURCE,
        key: { endpoint: query.key },
        subscriber: {
          events: query.events,
          debounceMs: DEBOUNCE_MS,
          run: () => {
            revalidationRuns += 1;
          },
        },
      }),
    ),
  );

  const listeners = getQueryRevalidationMetrics().eventSubscriptions;

  for (const eventType of EVENT_STREAM) {
    activityBus.emitLocal(eventType, undefined as never);
    const armed = getQueryRevalidationMetrics().armedTimers;
    timersArmed += armed;
    // Let each debounce elapse so the run actually happens, as it would
    // between real user events.
    await new Promise((resolve) => setTimeout(resolve, DEBOUNCE_MS + 20));
  }

  for (const handle of handles) handle.release();

  return {
    listeners,
    timersArmed,
    revalidationRuns,
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
  const consumers = QUERIES.reduce((sum, q) => sum + q.consumers, 0);
  const previous = measurePrevious();
  const retained = await measureRetained();

  console.log(
    `${consumers} mounted consumers across ${QUERIES.length} retained queries, ` +
      `${EVENT_STREAM.length} activity events`,
  );
  console.log("");
  console.log(
    `activityBus listeners: ${previous.listeners} -> ${retained.listeners} ` +
      `(${percentAvoided(previous.listeners, retained.listeners)} avoided, ` +
      `${ratio(previous.listeners, retained.listeners)})`,
  );
  console.log(
    `debounce timers armed: ${previous.timersArmed} -> ${retained.timersArmed} ` +
      `(${ratio(previous.timersArmed, retained.timersArmed)})`,
  );
  console.log(
    `revalidation requests: ${previous.revalidationRuns} -> ` +
      `${retained.revalidationRuns} ` +
      `(${percentAvoided(previous.revalidationRuns, retained.revalidationRuns)} avoided, ` +
      `${ratio(previous.revalidationRuns, retained.revalidationRuns)})`,
  );
  console.log("");
  console.log(
    "Note: arm A's request count is its fast-response case. When a response " +
      "outlives the gap between consumer timers, its extra requests join the " +
      "open one instead, and both arms issue one per event.",
  );

  // Every event that mattered to some consumer must still cause a revalidation.
  const expectedRuns = EVENT_STREAM.reduce(
    (sum, eventType) =>
      sum + QUERIES.filter((q) => q.events.includes(eventType)).length,
    0,
  );
  if (retained.revalidationRuns !== expectedRuns) {
    throw new Error(
      `owner ran ${retained.revalidationRuns} revalidations, expected ` +
        `${expectedRuns} — one per (query, matching event)`,
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
