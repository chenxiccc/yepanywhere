/**
 * Reload-status acquisitions before and after the family moved onto one shared
 * per-source snapshot.
 *
 * Arm B drives the real query controller and the real revalidation owner with
 * the wiring `useReloadNotifications` now uses: two query keys — dev status and
 * restart safety — retained per source. Arm A models the previous shape, where
 * each mounted consumer acquired both on mount and again on every reconnect.
 *
 * The consumer count is deliberately larger than YA mounts today; the point is
 * that the shared cost stops depending on it at all.
 *
 * The preceding step — dropping the per-instance connection poll, the duplicate
 * startup read, and the ungated safety requests — is measured separately by
 * `benchmark:reload-status-fanout`.
 */
import { activityBus } from "../src/lib/activityBus.js";
import {
  ensureClientQuery,
  resetClientQueryControllerForTests,
} from "../src/lib/clientQueryController.js";
import {
  type QueryRevalidationHandle,
  resetQueryRevalidationForTests,
  retainQueryRevalidation,
} from "../src/lib/clientQueryRevalidation.js";
import { asClientSummarySourceKey } from "../src/lib/clientSummaryStore.js";

const SOURCE = asClientSummarySourceKey("host:benchmark");
const CONSUMERS = 20;
const RECONNECTS = 10;
const KEYS = ["dev-status", "dev-restart-safety"];

/** Arm A — one acquisition per consumer, on mount and on every reconnect. */
function measurePrevious(): number {
  return CONSUMERS * (1 + RECONNECTS) * KEYS.length;
}

/** Arm B — the real controller and the real owner. */
async function measureShared(): Promise<number> {
  resetClientQueryControllerForTests();
  resetQueryRevalidationForTests();

  let requests = 0;
  const fetcher = async (): Promise<void> => {
    requests += 1;
  };

  const handles: QueryRevalidationHandle[] = [];
  for (let consumer = 0; consumer < CONSUMERS; consumer += 1) {
    for (const key of KEYS) {
      // Mount: the first consumer to ask pays, the rest find the entry fresh.
      await ensureClientQuery({ sourceKey: SOURCE, key, fetcher });
      handles.push(
        retainQueryRevalidation({
          sourceKey: SOURCE,
          key,
          subscriber: {
            events: ["reconnect"],
            debounceMs: 0,
            run: () => {
              void ensureClientQuery({
                sourceKey: SOURCE,
                key,
                force: true,
                fetcher,
              });
            },
          },
        }),
      );
    }
  }

  for (let index = 0; index < RECONNECTS; index += 1) {
    activityBus.emitLocal("reconnect", undefined as never);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  for (const handle of handles) handle.release();
  return requests;
}

async function main(): Promise<void> {
  const previous = measurePrevious();
  const shared = await measureShared();
  const expected = KEYS.length * (1 + RECONNECTS);

  console.log(
    `${CONSUMERS} mounted consumers, ${KEYS.length} query keys, ${RECONNECTS} reconnects`,
  );
  console.log(
    `acquisitions: ${previous} -> ${shared} ` +
      `(${(((previous - shared) / previous) * 100).toFixed(2)}% avoided, ` +
      `${(previous / shared).toFixed(2)}x)`,
  );

  if (shared !== expected) {
    throw new Error(
      `shared arm made ${shared} acquisitions, expected ${expected} — one per key per event`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
