/**
 * Global session collection walks with and without the conditional read.
 *
 * `GET /api/sessions` walks every project and enriches every row. Arm A is the
 * previous shape: every tab's every revalidation repeats that walk. Arm B
 * drives the real `SessionCollectionGeneration` off the real `EventBus`, so a
 * revalidation with an unchanged collection costs a comparison.
 *
 * The scenario is deliberately simple — a fixed number of tabs revalidating on
 * a fixed number of events, some of which change nothing a row renders.
 */
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
