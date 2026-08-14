export interface BrowserDebugPerformanceObservation {
  category?: string;
  count?: number;
  durationMs?: number;
  chars?: number;
  bytes?: number;
}

interface BrowserDebugPerformanceMetricSnapshot {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalChars: number;
  maxChars: number;
  totalBytes: number;
  maxBytes: number;
  categories: Record<string, number>;
}

interface BrowserDebugMainThreadSnapshot {
  keyEvents: number;
  delayedKeystrokes: number;
  keyDispatch: BrowserDebugDurationSnapshot;
  keyToFrame: BrowserDebugDurationSnapshot;
  frameGaps: BrowserDebugDurationSnapshot;
  longTasks: BrowserDebugDurationSnapshot;
}

interface BrowserDebugDurationSnapshot {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface BrowserDebugPerformanceSnapshot {
  version: 1;
  sessionId: string;
  startedAt: string;
  sampledAt: string;
  elapsedMs: number;
  visibility: {
    state: DocumentVisibilityState;
    visibleMs: number;
    hiddenMs: number;
    changes: number;
  };
  page: {
    sampledAt: string;
    elementCount: number;
    usedJSHeapSize?: number;
    totalJSHeapSize?: number;
  };
  totals: {
    mainThread: BrowserDebugMainThreadSnapshot;
    app: Record<string, BrowserDebugPerformanceMetricSnapshot>;
  };
  recent: {
    /** The previous complete five-second window plus the current partial one. */
    windowMs: number;
    mainThread: BrowserDebugMainThreadSnapshot;
    app: Record<string, BrowserDebugPerformanceMetricSnapshot>;
  };
}

export interface BrowserDebugPerformanceSummary {
  recentWindowMs: number;
  recentMaxDelayMs: number;
  recentLongTaskCount: number;
  recentFrameGapCount: number;
  recentDelayedKeystrokeCount: number;
}

interface MutableDurationStats {
  count: number;
  totalMs: number;
  maxMs: number;
}

interface MutableMainThreadStats {
  keyEvents: number;
  delayedKeystrokes: number;
  keyDispatch: MutableDurationStats;
  keyToFrame: MutableDurationStats;
  frameGaps: MutableDurationStats;
  longTasks: MutableDurationStats;
}

interface MutableMetricStats {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
  totalChars: number;
  maxChars: number;
  totalBytes: number;
  maxBytes: number;
  categories: Map<string, number>;
}

type BrowserDebugPerformanceEmit = (kind: string, data?: unknown) => void;

const SAMPLE_INTERVAL_MS = 5_000;
const FRAME_GAP_THRESHOLD_MS = 100;
const KEY_DISPATCH_THRESHOLD_MS = 25;
const KEY_TO_FRAME_THRESHOLD_MS = 50;
const MAX_APP_METRICS = 64;
const MAX_METRIC_CATEGORIES = 32;
const METRIC_NAME_LIMIT = 80;
const CATEGORY_NAME_LIMIT = 80;

let activeRecorder: BrowserDebugPerformanceRecorder | null = null;

function nowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

function createDurationStats(): MutableDurationStats {
  return { count: 0, totalMs: 0, maxMs: 0 };
}

function createMainThreadStats(): MutableMainThreadStats {
  return {
    keyEvents: 0,
    delayedKeystrokes: 0,
    keyDispatch: createDurationStats(),
    keyToFrame: createDurationStats(),
    frameGaps: createDurationStats(),
    longTasks: createDurationStats(),
  };
}

function createMetricStats(): MutableMetricStats {
  return {
    count: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
    totalChars: 0,
    maxChars: 0,
    totalBytes: 0,
    maxBytes: 0,
    categories: new Map(),
  };
}

function finiteNonNegative(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : 0;
}

function recordDuration(stats: MutableDurationStats, durationMs: number): void {
  const duration = finiteNonNegative(durationMs);
  stats.count += 1;
  stats.totalMs += duration;
  stats.maxMs = Math.max(stats.maxMs, duration);
}

function mergeDurationStats(
  left: MutableDurationStats,
  right: MutableDurationStats,
): MutableDurationStats {
  return {
    count: left.count + right.count,
    totalMs: left.totalMs + right.totalMs,
    maxMs: Math.max(left.maxMs, right.maxMs),
  };
}

function snapshotDuration(
  stats: MutableDurationStats,
): BrowserDebugDurationSnapshot {
  return {
    count: stats.count,
    totalMs: Math.round(stats.totalMs * 10) / 10,
    maxMs: Math.round(stats.maxMs * 10) / 10,
  };
}

function mergeMainThreadStats(
  left: MutableMainThreadStats,
  right: MutableMainThreadStats,
): MutableMainThreadStats {
  return {
    keyEvents: left.keyEvents + right.keyEvents,
    delayedKeystrokes: left.delayedKeystrokes + right.delayedKeystrokes,
    keyDispatch: mergeDurationStats(left.keyDispatch, right.keyDispatch),
    keyToFrame: mergeDurationStats(left.keyToFrame, right.keyToFrame),
    frameGaps: mergeDurationStats(left.frameGaps, right.frameGaps),
    longTasks: mergeDurationStats(left.longTasks, right.longTasks),
  };
}

function snapshotMainThread(
  stats: MutableMainThreadStats,
): BrowserDebugMainThreadSnapshot {
  return {
    keyEvents: stats.keyEvents,
    delayedKeystrokes: stats.delayedKeystrokes,
    keyDispatch: snapshotDuration(stats.keyDispatch),
    keyToFrame: snapshotDuration(stats.keyToFrame),
    frameGaps: snapshotDuration(stats.frameGaps),
    longTasks: snapshotDuration(stats.longTasks),
  };
}

function mergeMetricStats(
  left: MutableMetricStats | undefined,
  right: MutableMetricStats | undefined,
): MutableMetricStats {
  const merged = createMetricStats();
  for (const source of [left, right]) {
    if (!source) continue;
    merged.count += source.count;
    merged.totalDurationMs += source.totalDurationMs;
    merged.maxDurationMs = Math.max(merged.maxDurationMs, source.maxDurationMs);
    merged.totalChars += source.totalChars;
    merged.maxChars = Math.max(merged.maxChars, source.maxChars);
    merged.totalBytes += source.totalBytes;
    merged.maxBytes = Math.max(merged.maxBytes, source.maxBytes);
    for (const [category, count] of source.categories) {
      merged.categories.set(
        category,
        (merged.categories.get(category) ?? 0) + count,
      );
    }
  }
  return merged;
}

function mergeMetricMaps(
  left: ReadonlyMap<string, MutableMetricStats>,
  right: ReadonlyMap<string, MutableMetricStats>,
): Map<string, MutableMetricStats> {
  const names = new Set([...left.keys(), ...right.keys()]);
  return new Map(
    [...names].map((name) => [
      name,
      mergeMetricStats(left.get(name), right.get(name)),
    ]),
  );
}

function snapshotMetricMap(
  metrics: ReadonlyMap<string, MutableMetricStats>,
): Record<string, BrowserDebugPerformanceMetricSnapshot> {
  return Object.fromEntries(
    [...metrics.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, metric]) => [
        name,
        {
          count: metric.count,
          totalDurationMs: Math.round(metric.totalDurationMs * 10) / 10,
          maxDurationMs: Math.round(metric.maxDurationMs * 10) / 10,
          totalChars: metric.totalChars,
          maxChars: metric.maxChars,
          totalBytes: metric.totalBytes,
          maxBytes: metric.maxBytes,
          categories: Object.fromEntries(
            [...metric.categories.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        },
      ]),
  );
}

function metricName(value: string, limit: number): string {
  const normalized = value.trim().slice(0, limit);
  return normalized || "unknown";
}

class BrowserDebugPerformanceRecorder {
  private startedAtWallMs = Date.now();
  private startedAtMonotonicMs = nowMs();
  private visibilityState = document.visibilityState;
  private visibilityChangedAtMs = this.startedAtMonotonicMs;
  private visibleMs = 0;
  private hiddenMs = 0;
  private visibilityChanges = 0;
  private totals = createMainThreadStats();
  private currentWindow = createMainThreadStats();
  private previousWindow = createMainThreadStats();
  private totalAppMetrics = new Map<string, MutableMetricStats>();
  private currentAppMetrics = new Map<string, MutableMetricStats>();
  private previousAppMetrics = new Map<string, MutableMetricStats>();
  private currentWindowStartedAtMs = this.startedAtMonotonicMs;
  private previousWindowStartedAtMs: number | null = null;
  private generation = 0;
  private pageSample = this.samplePage();
  private previousFrameMs: number | null =
    document.visibilityState === "visible" ? nowMs() : null;
  private frameRequest = 0;
  private sampleInterval: ReturnType<typeof setInterval> | null = null;
  private longTaskObserver: PerformanceObserver | null = null;
  private stopped = false;
  private readonly priorDebugApi: unknown;
  private readonly priorLegacyEmit: unknown;

  constructor(
    private readonly sessionId: string,
    private readonly emit: BrowserDebugPerformanceEmit,
  ) {
    const debugGlobal = window as unknown as Record<string, unknown>;
    this.priorDebugApi = debugGlobal.__YA_BROWSER_DEBUG__;
    this.priorLegacyEmit = debugGlobal.__YA_BROWSER_DEBUG_EMIT__;
    const mark = (name: string, data?: unknown) => {
      this.record("app.annotation", {
        category: metricName(String(name), CATEGORY_NAME_LIMIT),
      });
      this.emit(
        `annotation.${metricName(String(name), METRIC_NAME_LIMIT)}`,
        data,
      );
    };
    debugGlobal.__YA_BROWSER_DEBUG__ = Object.freeze({
      version: 1,
      performance: Object.freeze({
        snapshot: () => this.snapshot(),
        reset: () => this.reset(),
        mark,
      }),
    });
    debugGlobal.__YA_BROWSER_DEBUG_EMIT__ = mark;

    window.addEventListener("keydown", this.onKeyDown, true);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    this.frameRequest = requestAnimationFrame(this.measureFrame);
    this.installLongTaskObserver();
    this.sampleInterval = setInterval(
      () => this.publishWindow(),
      SAMPLE_INTERVAL_MS,
    );
  }

  record(name: string, observation: BrowserDebugPerformanceObservation): void {
    if (this.stopped) return;
    const normalizedName = metricName(name, METRIC_NAME_LIMIT);
    this.recordMetric(this.totalAppMetrics, normalizedName, observation);
    this.recordMetric(this.currentAppMetrics, normalizedName, observation);
  }

  snapshot(): BrowserDebugPerformanceSnapshot {
    const sampledAtWallMs = Date.now();
    const sampledAtMonotonicMs = nowMs();
    const recentMainThread = mergeMainThreadStats(
      this.previousWindow,
      this.currentWindow,
    );
    return {
      version: 1,
      sessionId: this.sessionId,
      startedAt: new Date(this.startedAtWallMs).toISOString(),
      sampledAt: new Date(sampledAtWallMs).toISOString(),
      elapsedMs:
        Math.round((sampledAtMonotonicMs - this.startedAtMonotonicMs) * 10) /
        10,
      visibility: this.snapshotVisibility(sampledAtMonotonicMs),
      page: this.pageSample,
      totals: {
        mainThread: snapshotMainThread(this.totals),
        app: snapshotMetricMap(this.totalAppMetrics),
      },
      recent: {
        windowMs:
          Math.round(
            (sampledAtMonotonicMs -
              (this.previousWindowStartedAtMs ??
                this.currentWindowStartedAtMs)) *
              10,
          ) / 10,
        mainThread: snapshotMainThread(recentMainThread),
        app: snapshotMetricMap(
          mergeMetricMaps(this.previousAppMetrics, this.currentAppMetrics),
        ),
      },
    };
  }

  summary(): BrowserDebugPerformanceSummary {
    const sampledAtMs = nowMs();
    const recent = mergeMainThreadStats(
      this.previousWindow,
      this.currentWindow,
    );
    return {
      recentWindowMs: Math.max(
        0,
        sampledAtMs -
          (this.previousWindowStartedAtMs ?? this.currentWindowStartedAtMs),
      ),
      recentMaxDelayMs: Math.max(
        recent.keyDispatch.maxMs,
        recent.keyToFrame.maxMs,
        recent.frameGaps.maxMs,
        recent.longTasks.maxMs,
      ),
      recentLongTaskCount: recent.longTasks.count,
      recentFrameGapCount: recent.frameGaps.count,
      recentDelayedKeystrokeCount: recent.delayedKeystrokes,
    };
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.commitVisibilityDuration(nowMs());
    window.removeEventListener("keydown", this.onKeyDown, true);
    document.removeEventListener("visibilitychange", this.onVisibilityChange);
    cancelAnimationFrame(this.frameRequest);
    this.longTaskObserver?.disconnect();
    if (this.sampleInterval) clearInterval(this.sampleInterval);
    this.sampleInterval = null;

    const debugGlobal = window as unknown as Record<string, unknown>;
    if (this.priorDebugApi === undefined)
      delete debugGlobal.__YA_BROWSER_DEBUG__;
    else debugGlobal.__YA_BROWSER_DEBUG__ = this.priorDebugApi;
    if (this.priorLegacyEmit === undefined) {
      delete debugGlobal.__YA_BROWSER_DEBUG_EMIT__;
    } else {
      debugGlobal.__YA_BROWSER_DEBUG_EMIT__ = this.priorLegacyEmit;
    }
  }

  private reset(): BrowserDebugPerformanceSnapshot {
    this.generation += 1;
    this.startedAtWallMs = Date.now();
    this.startedAtMonotonicMs = nowMs();
    this.visibilityState = document.visibilityState;
    this.visibilityChangedAtMs = this.startedAtMonotonicMs;
    this.visibleMs = 0;
    this.hiddenMs = 0;
    this.visibilityChanges = 0;
    this.totals = createMainThreadStats();
    this.currentWindow = createMainThreadStats();
    this.previousWindow = createMainThreadStats();
    this.totalAppMetrics.clear();
    this.currentAppMetrics.clear();
    this.previousAppMetrics.clear();
    this.currentWindowStartedAtMs = this.startedAtMonotonicMs;
    this.previousWindowStartedAtMs = null;
    this.previousFrameMs =
      document.visibilityState === "visible" ? this.startedAtMonotonicMs : null;
    this.pageSample = this.samplePage();
    return this.snapshot();
  }

  private recordMetric(
    metrics: Map<string, MutableMetricStats>,
    name: string,
    observation: BrowserDebugPerformanceObservation,
  ): void {
    let metric = metrics.get(name);
    if (!metric) {
      if (metrics.size >= MAX_APP_METRICS) return;
      metric = createMetricStats();
      metrics.set(name, metric);
    }
    const count = Math.max(0, Math.floor(observation.count ?? 1));
    const durationMs = finiteNonNegative(observation.durationMs);
    const chars = Math.floor(finiteNonNegative(observation.chars));
    const bytes = Math.floor(finiteNonNegative(observation.bytes));
    metric.count += count;
    metric.totalDurationMs += durationMs;
    metric.maxDurationMs = Math.max(metric.maxDurationMs, durationMs);
    metric.totalChars += chars;
    metric.maxChars = Math.max(metric.maxChars, chars);
    metric.totalBytes += bytes;
    metric.maxBytes = Math.max(metric.maxBytes, bytes);
    if (observation.category) {
      const category = metricName(observation.category, CATEGORY_NAME_LIMIT);
      if (
        metric.categories.has(category) ||
        metric.categories.size < MAX_METRIC_CATEGORIES
      ) {
        metric.categories.set(
          category,
          (metric.categories.get(category) ?? 0) + count,
        );
      }
    }
  }

  private recordMainThreadDuration(
    field: "keyDispatch" | "keyToFrame" | "frameGaps" | "longTasks",
    durationMs: number,
  ): void {
    recordDuration(this.totals[field], durationMs);
    recordDuration(this.currentWindow[field], durationMs);
  }

  private readonly onKeyDown = (event: KeyboardEvent) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!(target.matches("textarea, input") || target.isContentEditable))
      return;
    const receivedAt = nowMs();
    const generation = this.generation;
    const dispatchDelayMs = Math.max(0, receivedAt - event.timeStamp);
    this.totals.keyEvents += 1;
    this.currentWindow.keyEvents += 1;
    this.recordMainThreadDuration("keyDispatch", dispatchDelayMs);
    requestAnimationFrame(() => {
      if (this.stopped || generation !== this.generation) return;
      const nextFrameDelayMs = Math.max(0, nowMs() - receivedAt);
      this.recordMainThreadDuration("keyToFrame", nextFrameDelayMs);
      if (
        dispatchDelayMs < KEY_DISPATCH_THRESHOLD_MS &&
        nextFrameDelayMs < KEY_TO_FRAME_THRESHOLD_MS
      ) {
        return;
      }
      this.totals.delayedKeystrokes += 1;
      this.currentWindow.delayedKeystrokes += 1;
      this.emit("composer.keystroke-latency", {
        key: event.key.length === 1 ? "printable" : event.key,
        dispatchDelayMs: Math.round(dispatchDelayMs * 10) / 10,
        nextFrameDelayMs: Math.round(nextFrameDelayMs * 10) / 10,
      });
    });
  };

  private readonly onVisibilityChange = () => {
    const measuredAt = nowMs();
    this.commitVisibilityDuration(measuredAt);
    this.visibilityState = document.visibilityState;
    this.visibilityChangedAtMs = measuredAt;
    this.visibilityChanges += 1;
    this.previousFrameMs = null;
  };

  private readonly measureFrame = () => {
    if (this.stopped) return;
    if (document.visibilityState !== "visible") {
      this.previousFrameMs = null;
    } else {
      const measuredAt = nowMs();
      if (this.previousFrameMs !== null) {
        const durationMs = measuredAt - this.previousFrameMs;
        if (durationMs >= FRAME_GAP_THRESHOLD_MS) {
          this.recordMainThreadDuration("frameGaps", durationMs);
          this.emit("performance.frame-gap", { durationMs });
        }
      }
      this.previousFrameMs = measuredAt;
    }
    this.frameRequest = requestAnimationFrame(this.measureFrame);
  };

  private installLongTaskObserver(): void {
    if (typeof PerformanceObserver === "undefined") return;
    try {
      this.longTaskObserver = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.startTime < this.startedAtMonotonicMs) continue;
          this.recordMainThreadDuration("longTasks", entry.duration);
          this.emit("performance.long-task", {
            startTime: entry.startTime,
            durationMs: entry.duration,
            name: entry.name,
          });
        }
      });
      this.longTaskObserver.observe({ type: "longtask" });
    } catch {
      this.longTaskObserver = null;
    }
  }

  private publishWindow(): void {
    if (this.stopped) return;
    const nextWindowStartedAtMs = nowMs();
    this.pageSample = this.samplePage();
    this.emit("performance.snapshot", this.snapshot());
    this.previousWindow = this.currentWindow;
    this.currentWindow = createMainThreadStats();
    this.previousAppMetrics = this.currentAppMetrics;
    this.currentAppMetrics = new Map();
    this.previousWindowStartedAtMs = this.currentWindowStartedAtMs;
    this.currentWindowStartedAtMs = nextWindowStartedAtMs;
  }

  private samplePage(): BrowserDebugPerformanceSnapshot["page"] {
    const memory = (
      performance as Performance & {
        memory?: { usedJSHeapSize?: number; totalJSHeapSize?: number };
      }
    ).memory;
    return {
      sampledAt: new Date().toISOString(),
      elementCount: document.getElementsByTagName("*").length,
      ...(memory?.usedJSHeapSize === undefined
        ? {}
        : { usedJSHeapSize: memory.usedJSHeapSize }),
      ...(memory?.totalJSHeapSize === undefined
        ? {}
        : { totalJSHeapSize: memory.totalJSHeapSize }),
    };
  }

  private commitVisibilityDuration(measuredAt: number): void {
    const elapsed = Math.max(0, measuredAt - this.visibilityChangedAtMs);
    if (this.visibilityState === "visible") this.visibleMs += elapsed;
    else this.hiddenMs += elapsed;
  }

  private snapshotVisibility(measuredAt: number) {
    const elapsed = Math.max(0, measuredAt - this.visibilityChangedAtMs);
    return {
      state: this.visibilityState,
      visibleMs:
        Math.round(
          (this.visibleMs +
            (this.visibilityState === "visible" ? elapsed : 0)) *
            10,
        ) / 10,
      hiddenMs:
        Math.round(
          (this.hiddenMs + (this.visibilityState !== "visible" ? elapsed : 0)) *
            10,
        ) / 10,
      changes: this.visibilityChanges,
    };
  }
}

export function installBrowserDebugPerformanceInstrumentation(
  sessionId: string,
  emit: BrowserDebugPerformanceEmit,
): () => void {
  if (activeRecorder) {
    throw new Error("Browser performance diagnostics are already active");
  }
  const recorder = new BrowserDebugPerformanceRecorder(sessionId, emit);
  activeRecorder = recorder;
  return () => {
    recorder.stop();
    if (activeRecorder === recorder) activeRecorder = null;
  };
}

export function isBrowserDebugPerformanceRecording(): boolean {
  return activeRecorder !== null;
}

export function recordBrowserDebugPerformanceMetric(
  name: string,
  observation: BrowserDebugPerformanceObservation = {},
): void {
  activeRecorder?.record(name, observation);
}

export function getBrowserDebugPerformanceSummary(): BrowserDebugPerformanceSummary | null {
  return activeRecorder?.summary() ?? null;
}
