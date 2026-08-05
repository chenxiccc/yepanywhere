/**
 * How much startup work competes with the selected route's own facts.
 *
 * The counts follow the 2026-08-05 fresh New Session census, grouped by the
 * tier each owner now declares. Arm A is the previous shape, where every hook
 * in the mount commit acquired immediately. Arm B drives the real coordinator.
 */
import {
  type ClientQueryBootstrapTier,
  acquireClientQueryBootstrapSlot,
  resetClientQueryBootstrapForTests,
} from "../src/lib/clientQueryBootstrap.js";
import { asClientSummarySourceKey } from "../src/lib/clientSummaryStore.js";

const SOURCE = asClientSummarySourceKey("host:benchmark");

const TIER_WORK: [ClientQueryBootstrapTier, number][] = [
  ["route", 5],
  ["navigation", 6],
  ["supplementary", 7],
];

const TOTAL = TIER_WORK.reduce((sum, [, count]) => sum + count, 0);
const ROUTE_WORK = TIER_WORK[0]?.[1] ?? 0;

/** Arm A — everything acquires in the mount commit. */
function measurePrevious(): number {
  return TOTAL - ROUTE_WORK;
}

/** Arm B — the real coordinator, one tier at a time. */
async function measureCoordinated(): Promise<{
  competing: number;
  startOrder: ClientQueryBootstrapTier[];
}> {
  resetClientQueryBootstrapForTests();

  const startOrder: ClientQueryBootstrapTier[] = [];
  let routeDone = false;
  let competing = 0;

  const pending = TIER_WORK.map(([tier, count]) => ({
    tier,
    slots: Array.from({ length: count }, () => {
      const slot = acquireClientQueryBootstrapSlot(SOURCE, tier);
      const started = slot.ready().then(() => {
        startOrder.push(tier);
        if (tier !== "route" && !routeDone) competing += 1;
      });
      return { slot, started };
    }),
  }));

  for (const { tier, slots } of pending) {
    await Promise.all(slots.map((entry) => entry.started));
    for (const entry of slots) entry.slot.settle();
    if (tier === "route") routeDone = true;
  }

  return { competing, startOrder };
}

async function main(): Promise<void> {
  const previous = measurePrevious();
  const { competing, startOrder } = await measureCoordinated();

  console.log(`${TOTAL} startup acquisitions across ${TIER_WORK.length} tiers`);
  console.log(
    `competing with the selected route's ${ROUTE_WORK} facts: ` +
      `${previous} -> ${competing} (${previous - competing} deferred)`,
  );
  console.log(`start order: ${[...new Set(startOrder)].join(" -> ")}`);

  if (competing !== 0) {
    throw new Error(
      `${competing} acquisitions still started before the route tier settled`,
    );
  }
  if (startOrder.length !== TOTAL) {
    throw new Error(
      `${startOrder.length} of ${TOTAL} acquisitions started; the gate stranded work`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
