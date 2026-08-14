// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BrowserDebugPerformanceSnapshot,
  getBrowserDebugPerformanceSummary,
  installBrowserDebugPerformanceInstrumentation,
  isBrowserDebugPerformanceRecording,
  recordBrowserDebugPerformanceMetric,
} from "../browserDebugPerformance";

describe("browser debug performance instrumentation", () => {
  const cleanups: Array<() => void> = [];
  const frameCallbacks: FrameRequestCallback[] = [];
  let now = 100;

  beforeEach(() => {
    now = 100;
    frameCallbacks.length = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("PerformanceObserver", undefined);
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("exposes bounded lease and app-phase snapshots", () => {
    const events: Array<{ kind: string; data?: unknown }> = [];
    const cleanup = installBrowserDebugPerformanceInstrumentation(
      "session-1",
      (kind, data) => events.push({ kind, data }),
    );
    cleanups.push(cleanup);

    recordBrowserDebugPerformanceMetric("streaming-content.flush", {
      category: "one-message",
      durationMs: 12.5,
      chars: 240,
    });
    const input = document.createElement("textarea");
    document.body.append(input);
    const keydown = new KeyboardEvent("keydown", {
      bubbles: true,
      key: "a",
    });
    Object.defineProperty(keydown, "timeStamp", { value: 60 });
    input.dispatchEvent(keydown);

    now = 175;
    frameCallbacks[1]?.(175);
    now = 240;
    frameCallbacks[0]?.(240);

    const debugApi = (
      window as unknown as {
        __YA_BROWSER_DEBUG__: {
          performance: { snapshot: () => unknown; reset: () => unknown };
        };
      }
    ).__YA_BROWSER_DEBUG__;
    const snapshot =
      debugApi.performance.snapshot() as BrowserDebugPerformanceSnapshot;

    expect(isBrowserDebugPerformanceRecording()).toBe(true);
    expect(snapshot).toMatchObject({
      version: 1,
      sessionId: "session-1",
      totals: {
        mainThread: {
          keyEvents: 1,
          delayedKeystrokes: 1,
          keyDispatch: { count: 1, maxMs: 40 },
          keyToFrame: { count: 1, maxMs: 75 },
          frameGaps: { count: 1, maxMs: 140 },
        },
        app: {
          "streaming-content.flush": {
            count: 1,
            totalDurationMs: 12.5,
            maxDurationMs: 12.5,
            totalChars: 240,
            categories: { "one-message": 1 },
          },
        },
      },
    });
    expect(getBrowserDebugPerformanceSummary()).toMatchObject({
      recentWindowMs: 140,
      recentMaxDelayMs: 140,
      recentFrameGapCount: 1,
      recentDelayedKeystrokeCount: 1,
    });
    expect(events.map((event) => event.kind)).toEqual([
      "composer.keystroke-latency",
      "performance.frame-gap",
    ]);

    now = 300;
    expect(debugApi.performance.reset()).toMatchObject({
      elapsedMs: 0,
      totals: {
        mainThread: { keyEvents: 0, delayedKeystrokes: 0 },
        app: {},
      },
      recent: { windowMs: 0, app: {} },
    });

    cleanup();
    cleanups.pop();
    expect(isBrowserDebugPerformanceRecording()).toBe(false);
    expect(
      "__YA_BROWSER_DEBUG__" in (window as unknown as Record<string, unknown>),
    ).toBe(false);
  });
});
