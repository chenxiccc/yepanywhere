/**
 * Measures the globally-mounted reload-notification hook's background cost.
 *
 * `useReloadNotifications` is mounted by the app shell and again by Settings
 * and the Development pane. Each instance polled `activityBus.connected` on its
 * own one-second interval forever, read `/api/dev/status` twice at startup (once
 * to learn the reload mode, then again inside the safety sync that discovery
 * triggered), and requested worker activity and safe-restart state on every
 * reconnect and visibility restore — including on deployments in neither reload
 * mode, which display none of it.
 *
 * Arm B drives the real `activityBus.subscribeConnected`, so the timer figure
 * is the shipped behavior: a subscription that notifies on change rather than a
 * clock. Request figures are modelled from the hook's call sites in both arms.
 */
import { performance } from "node:perf_hooks";
import { activityBus } from "../src/lib/activityBus.js";

/** App shell, Settings layout, Development pane. */
const CONSUMERS = 3;
const SESSION_MINUTES = 10;
const CONNECTION_POLL_MS = 1_000;
/** Reconnects and visibility restores over the session. */
const SYNC_EVENTS = 8;

interface ArmResult {
  connectionWakeups: number;
  devStatusReads: number;
  restartSafetyReads: number;
  durationMs: number;
}

const pollTicks = (SESSION_MINUTES * 60_000) / CONNECTION_POLL_MS;

const SAFETY_READS_PER_SYNC = 2; // /status/workers + /dev/safe-restart

/** Arm A — one interval per consumer, two startup reads, ungated safety sync. */
function measurePrevious(mode: "development" | "production"): ArmResult {
  const startedAt = performance.now();
  // Startup read the mode, then the safety sync that discovery triggered read
  // `/api/dev/status` again wherever a reload mode was active.
  const startupDevStatus = mode === "development" ? 2 : 1;
  // Reconnect and visibility restore synced everything regardless of mode.
  const startupSafetySyncs = mode === "development" ? 1 : 0;

  return {
    connectionWakeups: CONSUMERS * pollTicks,
    devStatusReads: CONSUMERS * (startupDevStatus + SYNC_EVENTS),
    restartSafetyReads:
      CONSUMERS * (startupSafetySyncs + SYNC_EVENTS) * SAFETY_READS_PER_SYNC,
    durationMs: performance.now() - startedAt,
  };
}

/** Arm B — the real connection subscription, one startup read, gated safety. */
function measureRetained(mode: "development" | "production"): ArmResult {
  const startedAt = performance.now();

  let notifications = 0;
  const releases = Array.from({ length: CONSUMERS }, () =>
    activityBus.subscribeConnected(() => {
      notifications += 1;
    }),
  );
  // A quiet session: no stream opened, errored, or closed, so a change-driven
  // subscription costs nothing at all where the interval charged every tick.
  for (const release of releases) release();

  // Each consumer still reads on its own at this step: only the duplicate
  // startup read is gone. Sharing the read across consumers came next, and
  // `benchmark:reload-status-shared-snapshot` measures it.
  const startupSafetySyncs = mode === "development" ? 1 : 0;

  return {
    connectionWakeups: notifications,
    devStatusReads: CONSUMERS * (1 + SYNC_EVENTS),
    restartSafetyReads:
      mode === "development"
        ? CONSUMERS * (startupSafetySyncs + SYNC_EVENTS) * SAFETY_READS_PER_SYNC
        : 0,
    durationMs: performance.now() - startedAt,
  };
}

function percentAvoided(before: number, after: number): string {
  if (before === 0) return "0.00%";
  return `${(((before - after) / before) * 100).toFixed(2)}%`;
}

function report(mode: "development" | "production"): void {
  const previous = measurePrevious(mode);
  const retained = measureRetained(mode);

  console.log(`--- ${mode} ---`);
  console.log(
    `connection wakeups: ${previous.connectionWakeups} -> ${retained.connectionWakeups} ` +
      `(${percentAvoided(previous.connectionWakeups, retained.connectionWakeups)} avoided)`,
  );
  console.log(
    `/api/dev/status reads: ${previous.devStatusReads} -> ${retained.devStatusReads} ` +
      `(${percentAvoided(previous.devStatusReads, retained.devStatusReads)} avoided)`,
  );
  console.log(
    `worker + safe-restart reads: ${previous.restartSafetyReads} -> ${retained.restartSafetyReads} ` +
      `(${percentAvoided(previous.restartSafetyReads, retained.restartSafetyReads)} avoided)`,
  );
  console.log("");
}

function main(): void {
  console.log(
    `${CONSUMERS} mounted consumers, ${SESSION_MINUTES} min, ` +
      `${SYNC_EVENTS} reconnect/refresh events`,
  );
  console.log("");
  report("development");
  report("production");
  console.log(
    "Note: this measures the poll/duplicate-read/gating step only, so each " +
      "consumer here still reads `/api/dev/status` on its own for every " +
      "reconnect and visibility restore. Collapsing that fan-out onto one " +
      "shared per-source snapshot landed next; run " +
      "`benchmark:reload-status-shared-snapshot` for it.",
  );

  const productionRetained = measureRetained("production");
  if (productionRetained.restartSafetyReads !== 0) {
    throw new Error(
      "production still requests worker or safe-restart detail it cannot display",
    );
  }
  const developmentRetained = measureRetained("development");
  if (developmentRetained.devStatusReads !== CONSUMERS * (1 + SYNC_EVENTS)) {
    throw new Error("startup still reads /api/dev/status more than once each");
  }
}

main();
