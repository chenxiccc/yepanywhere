/**
 * Global session collection walks with and without the conditional read.
 *
 * `GET /api/sessions` walks every project and enriches every row. Arm A is the
 * previous shape: every tab's every revalidation repeats that walk. Arm B
 * drives the real `SessionCollectionGeneration` off the real `EventBus`, so a
 * revalidation with an unchanged collection costs a comparison.
 *
 * The second measurement covers the cold path the conditional read cannot help
 * with: every tab reconnecting at once, none holding a generation yet, where
 * the real `SourceVersionedSingleFlight` is what collapses the herd.
 *
 * Both scenarios are deliberately simple — fixed tab and event counts, not a
 * model of any particular install.
 */
import { SourceVersionedSingleFlight } from "../src/lib/sourceVersionedSingleFlight.js";
import { SessionCollectionGeneration } from "../src/sessions/sessionCollectionGeneration.js";
import { EventBus } from "../src/watcher/EventBus.js";

const TABS = 20;
/** Events that change a row, so every tab must re-read after each. */
const ROW_EVENTS = 5;
/** Events that reach the bus but change nothing a row renders. */
const CONNECTION_EVENTS = 15;

function event(type: string): never {
  return { type, timestamp: new Date(0).toISOString() } as never;
}

/**
 * The cold path no conditional read can help with: every tab reconnects at
 * once, none holding a generation yet.
 */
async function measureHerd(): Promise<void> {
  const walks = new SourceVersionedSingleFlight<string, number>({
    maxRetainedBytes: 1024 * 1024,
    estimateBytes: () => 64,
  });
  let computations = 0;

  const readOnce = (generation: number): Promise<unknown> =>
    walks.run({
      key: "global-sessions",
      sourceVersion: String(generation),
      compute: async () => {
        computations += 1;
        // Stand in for the project walk; any await is enough to let the rest of
        // the herd arrive while this one is open.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return computations;
      },
      isCurrent: () => true,
    });

  await Promise.all(Array.from({ length: TABS }, () => readOnce(1)));
  const coldWalks = computations;

  // The collection changes, and the herd arrives again.
  await Promise.all(Array.from({ length: TABS }, () => readOnce(2)));

  console.log("");
  console.log(`${TABS} tabs reconnecting at once, then again after a change`);
  console.log(
    `cold walks: ${TABS * 2} -> ${computations} ` +
      `(${(((TABS * 2 - computations) / (TABS * 2)) * 100).toFixed(2)}% avoided, ` +
      `${((TABS * 2) / computations).toFixed(2)}x)`,
  );

  if (coldWalks !== 1 || computations !== 2) {
    throw new Error(
      `herd cost ${coldWalks} then ${computations} walks, expected one per generation`,
    );
  }
}

function main(): void {
  const bus = new EventBus();
  const generation = new SessionCollectionGeneration(bus);

  let walks = 0;
  const known = new Map<number, number>();
  const revalidate = (tab: number): void => {
    if (generation.matches(known.get(tab))) return;
    walks += 1;
    known.set(tab, generation.current);
  };

  // Initial load, then one revalidation per tab per event.
  for (let tab = 0; tab < TABS; tab += 1) revalidate(tab);

  const events = [
    ...Array.from({ length: ROW_EVENTS }, () => "session-metadata-changed"),
    ...Array.from({ length: CONNECTION_EVENTS }, () => "browser-tab-connected"),
  ];
  for (const type of events) {
    bus.emit(event(type));
    for (let tab = 0; tab < TABS; tab += 1) revalidate(tab);
  }

  const previous = TABS * (1 + events.length);
  console.log(
    `${TABS} tabs, ${ROW_EVENTS} row-changing and ${CONNECTION_EVENTS} connection-only events`,
  );
  console.log(
    `collection walks: ${previous} -> ${walks} ` +
      `(${(((previous - walks) / previous) * 100).toFixed(2)}% avoided, ` +
      `${(previous / walks).toFixed(2)}x)`,
  );

  // Every tab must still re-read after every row-changing event: the gain has
  // to come from skipping unchanged reads, never from serving stale rows.
  const expected = TABS * (1 + ROW_EVENTS);
  if (walks !== expected) {
    throw new Error(
      `${walks} walks, expected ${expected} — one per tab per row-changing event plus the initial load`,
    );
  }
}

main();
measureHerd().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
