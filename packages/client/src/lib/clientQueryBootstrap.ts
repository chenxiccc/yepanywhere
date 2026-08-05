/**
 * One bootstrap coordinator per retained source.
 *
 * A fresh tab mounts every app-shell hook in the same commit, so the selected
 * route's minimum facts race global collection feeds and diagnostic reads for
 * the browser's connection slots and the server's first turn. The 2026-08-05
 * request census watched provider controls appear at about 5.5 s while
 * `/api/processes`, `/api/inbox`, and the development-status family were
 * already in flight — none of which the selected page renders.
 *
 * Work therefore declares a tier, and a tier starts only once every earlier
 * tier's registered bootstrap work has settled:
 *
 * - `route` — what the selected page needs to paint its own controls;
 * - `navigation` — stable shell counts and coverage, retained across routes;
 * - `supplementary` — diagnostics, enrichment, and usage telemetry.
 *
 * Three properties are load-bearing:
 *
 * **It gates the first acquisition only.** Once the last tier opens, the source
 * is done bootstrapping and never gates again. Revalidations — reconnect,
 * visibility restore, an explicit refetch — are never gated, because a stalled
 * bootstrap must not also stall recovery.
 *
 * **Opening is always deferred by at least a microtask.** Every hook in the
 * mount commit registers synchronously before any tier is evaluated. Advancing
 * eagerly would let a navigation hook that mounts first find no route work
 * registered yet and open the gate on itself.
 *
 * **A tier's deadline releases the next one.** A route request that hangs must
 * not withhold navigation forever; blocking decorative work is the goal, losing
 * the shell is not.
 */
import type { ClientSummarySourceKey } from "./clientSummaryStore";

export type ClientQueryBootstrapTier = "route" | "navigation" | "supplementary";

const TIERS: readonly ClientQueryBootstrapTier[] = [
  "route",
  "navigation",
  "supplementary",
];

const LAST_TIER = TIERS.length - 1;

/**
 * How long one tier may hold the next. The census's slowest selected-route
 * request took about 5.2 s, so this deliberately does not wait for the worst
 * case: it buys the route the first turn without letting it own the whole load.
 */
const TIER_DEADLINE_MS = 2_000;

export interface ClientQueryBootstrapSlot {
  /** Resolves when this slot's tier is open. */
  ready(): Promise<void>;
  /** This slot's bootstrap work finished, successfully or not. Idempotent. */
  settle(): void;
}

interface BootstrapWaiter {
  tier: number;
  resolve: () => void;
}

interface BootstrapSource {
  openTier: number;
  /** Registered-but-unsettled slots per tier. */
  outstanding: number[];
  waiters: BootstrapWaiter[];
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  advanceScheduled: boolean;
  /** Every tier has opened; this source no longer gates anything. */
  complete: boolean;
}

const sources = new Map<ClientSummarySourceKey, BootstrapSource>();

const OPEN_SLOT: ClientQueryBootstrapSlot = {
  ready: () => Promise.resolve(),
  settle: () => {},
};

function getOrCreateSource(sourceKey: ClientSummarySourceKey): BootstrapSource {
  let source = sources.get(sourceKey);
  if (!source) {
    source = {
      openTier: 0,
      outstanding: TIERS.map(() => 0),
      waiters: [],
      deadlineTimer: null,
      advanceScheduled: false,
      complete: false,
    };
    sources.set(sourceKey, source);
  }
  return source;
}

function clearDeadline(source: BootstrapSource): void {
  if (source.deadlineTimer !== null) {
    clearTimeout(source.deadlineTimer);
    source.deadlineTimer = null;
  }
}

function openNextTier(source: BootstrapSource): void {
  source.openTier += 1;
  const remaining: BootstrapWaiter[] = [];
  for (const waiter of source.waiters) {
    if (waiter.tier <= source.openTier) {
      waiter.resolve();
    } else {
      remaining.push(waiter);
    }
  }
  source.waiters = remaining;
  if (source.openTier >= LAST_TIER) {
    source.complete = true;
    source.waiters = [];
    clearDeadline(source);
  }
}

function isBlocked(source: BootstrapSource): boolean {
  for (let tier = 0; tier <= source.openTier; tier += 1) {
    if ((source.outstanding[tier] ?? 0) > 0) return true;
  }
  return false;
}

function advance(source: BootstrapSource): void {
  while (!source.complete && !isBlocked(source)) {
    openNextTier(source);
  }
  if (source.complete) {
    return;
  }
  // Still blocked: hold the next tier, but not indefinitely.
  if (source.deadlineTimer === null) {
    source.deadlineTimer = setTimeout(() => {
      source.deadlineTimer = null;
      if (source.complete) return;
      openNextTier(source);
      advance(source);
    }, TIER_DEADLINE_MS);
  }
}

function scheduleAdvance(source: BootstrapSource): void {
  if (source.advanceScheduled || source.complete) return;
  source.advanceScheduled = true;
  queueMicrotask(() => {
    source.advanceScheduled = false;
    advance(source);
  });
}

export function acquireClientQueryBootstrapSlot(
  sourceKey: ClientSummarySourceKey,
  tier: ClientQueryBootstrapTier,
): ClientQueryBootstrapSlot {
  const source = getOrCreateSource(sourceKey);
  if (source.complete) {
    return OPEN_SLOT;
  }

  const tierIndex = TIERS.indexOf(tier);
  source.outstanding[tierIndex] = (source.outstanding[tierIndex] ?? 0) + 1;
  scheduleAdvance(source);

  let settled = false;
  return {
    ready() {
      if (source.complete || tierIndex <= source.openTier) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        source.waiters.push({ tier: tierIndex, resolve });
      });
    },
    settle() {
      if (settled) return;
      settled = true;
      source.outstanding[tierIndex] = Math.max(
        0,
        (source.outstanding[tierIndex] ?? 0) - 1,
      );
      // A tier that just emptied may open the next one; one that did not
      // still restarts the deadline evaluation.
      clearDeadline(source);
      scheduleAdvance(source);
    },
  };
}

export interface ClientQueryBootstrapMetrics {
  openTier: ClientQueryBootstrapTier;
  complete: boolean;
  outstanding: number[];
  waiting: number;
}

export function getClientQueryBootstrapMetrics(
  sourceKey: ClientSummarySourceKey,
): ClientQueryBootstrapMetrics | undefined {
  const source = sources.get(sourceKey);
  if (!source) return undefined;
  return {
    openTier: TIERS[source.openTier] as ClientQueryBootstrapTier,
    complete: source.complete,
    outstanding: [...source.outstanding],
    waiting: source.waiters.length,
  };
}

export function resetClientQueryBootstrapForTests(): void {
  for (const source of sources.values()) {
    clearDeadline(source);
    for (const waiter of source.waiters) waiter.resolve();
  }
  sources.clear();
}
