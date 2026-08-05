// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJSON } from "../../api/client";
import { activityBus } from "../../lib/activityBus";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import { resetQueryRevalidationForTests } from "../../lib/clientQueryRevalidation";
import { resetDevReloadStatusForTests } from "../../lib/devReloadStatusStore";
import {
  FRONTEND_RELOAD_QUERY_PARAM,
  buildFrontendReloadUrl,
  getFrontendReloadCleanupUrl,
  getVisibleReloadBanners,
  useReloadNotifications,
} from "../useReloadNotifications";

vi.mock("../../api/client", () => ({
  fetchJSON: vi.fn(),
}));

const mockFetchJSON = vi.mocked(fetchJSON);

const workerActivity = {
  type: "worker-activity-changed" as const,
  activeWorkers: 0,
  interruptibleSessionCount: 0,
  queueLength: 0,
  queuedSessionMessageCount: 0,
  hasActiveWork: false,
  timestamp: "2026-07-05T00:00:00.000Z",
};

const idleSafeRestartState = {
  status: "idle" as const,
  blockers: [],
  canRestartNow: true,
  updatedAt: "2026-07-05T00:00:00.000Z",
};

let backendDirty = false;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

beforeEach(() => {
  // The reload-status facts are shared per source, so a previous test's
  // snapshot would otherwise answer this one's mount without a request.
  resetDevReloadStatusForTests();
  resetClientQueryControllerForTests();
  resetQueryRevalidationForTests();
  backendDirty = false;
  mockFetchJSON.mockImplementation(async (url) => {
    if (url === "/dev/status") {
      return {
        noBackendReload: true,
        noFrontendReload: true,
        backendDirty,
      } as never;
    }
    if (url === "/status/workers") {
      return workerActivity as never;
    }
    if (url === "/dev/safe-restart") {
      return idleSafeRestartState as never;
    }
    return {} as never;
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("useReloadNotifications URL helpers", () => {
  it("adds a cache-busting reload param while preserving query and hash", () => {
    const nextUrl = buildFrontendReloadUrl(
      "https://example.test/projects?foo=bar#session-1",
      "12345",
    );
    const parsed = new URL(nextUrl);

    expect(parsed.searchParams.get("foo")).toBe("bar");
    expect(parsed.searchParams.get(FRONTEND_RELOAD_QUERY_PARAM)).toBe("12345");
    expect(parsed.hash).toBe("#session-1");
  });

  it("removes only the reload param during post-load cleanup", () => {
    const cleanedUrl = getFrontendReloadCleanupUrl(
      "https://example.test/projects?foo=bar&__ya_reload=12345#session-1",
    );

    expect(cleanedUrl).toBe("https://example.test/projects?foo=bar#session-1");
  });

  it("returns null when there is no reload param to clean up", () => {
    expect(
      getFrontendReloadCleanupUrl(
        "https://example.test/projects?foo=bar#session-1",
      ),
    ).toBeNull();
  });
});

describe("getVisibleReloadBanners", () => {
  it("gives backend reloads precedence over frontend reloads", () => {
    expect(
      getVisibleReloadBanners(true, { backend: true, frontend: true }),
    ).toEqual({ backend: true, frontend: false });

    expect(
      getVisibleReloadBanners(true, { backend: false, frontend: true }),
    ).toEqual({ backend: false, frontend: true });

    expect(
      getVisibleReloadBanners(false, { backend: true, frontend: true }),
    ).toEqual({ backend: false, frontend: false });
  });

  it("hides backend and frontend reload banners until backend safety is known", () => {
    expect(
      getVisibleReloadBanners(
        true,
        { backend: true, frontend: true },
        { backendReloadSafetyKnown: false },
      ),
    ).toEqual({ backend: false, frontend: false });
  });
});

describe("useReloadNotifications dismissal", () => {
  it("retries a transient backend safety sync failure", async () => {
    vi.useFakeTimers();
    let workerAttempts = 0;
    mockFetchJSON.mockImplementation(async (url) => {
      if (url === "/dev/status") {
        return {
          noBackendReload: true,
          noFrontendReload: true,
          backendDirty: true,
        } as never;
      }
      if (url === "/status/workers") {
        workerAttempts += 1;
        if (workerAttempts === 1) throw new Error("transient worker failure");
        return workerActivity as never;
      }
      if (url === "/dev/safe-restart") {
        return idleSafeRestartState as never;
      }
      return {} as never;
    });

    const hook = renderHook(() => useReloadNotifications());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(hook.result.current.backendReloadSafetyKnown).toBe(false);

    await act(async () => {
      vi.runOnlyPendingTimers();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(workerAttempts).toBe(2);
    expect(hook.result.current.backendReloadSafetyKnown).toBe(true);
  });

  it("keeps backend reload safety unknown until worker and safe restart sync finish", async () => {
    const workerActivityResult = deferred<typeof workerActivity>();
    const safeRestartResult = deferred<typeof idleSafeRestartState>();
    mockFetchJSON.mockImplementation(async (url) => {
      if (url === "/dev/status") {
        return {
          noBackendReload: true,
          noFrontendReload: true,
          backendDirty: true,
        } as never;
      }
      if (url === "/status/workers") {
        return (await workerActivityResult.promise) as never;
      }
      if (url === "/dev/safe-restart") {
        return (await safeRestartResult.promise) as never;
      }
      return {} as never;
    });

    const hook = renderHook(() => useReloadNotifications());

    await waitFor(() => {
      expect(hook.result.current.pendingReloads.backend).toBe(true);
    });
    expect(hook.result.current.backendReloadSafetyKnown).toBe(false);
    expect(
      getVisibleReloadBanners(true, hook.result.current.pendingReloads, {
        backendReloadSafetyKnown: hook.result.current.backendReloadSafetyKnown,
      }),
    ).toEqual({ backend: false, frontend: false });

    await act(async () => {
      workerActivityResult.resolve(workerActivity);
      await workerActivityResult.promise;
    });

    expect(hook.result.current.backendReloadSafetyKnown).toBe(false);

    await act(async () => {
      safeRestartResult.resolve(idleSafeRestartState);
      await safeRestartResult.promise;
    });

    await waitFor(() => {
      expect(hook.result.current.backendReloadSafetyKnown).toBe(true);
    });
  });

  it("keeps dismissed backend reloads hidden until the page state is recreated", async () => {
    const first = renderHook(() => useReloadNotifications());

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    await act(async () => {
      activityBus.emitLocal("source-change", {
        type: "source-change",
        target: "backend",
        files: ["server.ts"],
        timestamp: "2026-07-05T00:00:00.000Z",
      });
    });

    expect(first.result.current.pendingReloads.backend).toBe(true);

    act(() => {
      first.result.current.dismiss("backend");
    });

    expect(first.result.current.pendingReloads.backend).toBe(false);

    await act(async () => {
      activityBus.emitLocal("source-change", {
        type: "source-change",
        target: "backend",
        files: ["server.ts"],
        timestamp: "2026-07-05T00:00:01.000Z",
      });
    });

    expect(first.result.current.pendingReloads.backend).toBe(false);

    backendDirty = true;
    await act(async () => {
      activityBus.emitLocal("refresh", undefined);
    });
    // The dirty flag reaches the shared snapshot on the refresh revalidation,
    // not on the next mount: a remount reads what the source already knows.
    await waitFor(() => {
      expect(
        mockFetchJSON.mock.calls.filter((call) => call[0] === "/dev/status"),
      ).toHaveLength(2);
    });

    expect(first.result.current.pendingReloads.backend).toBe(false);

    first.unmount();
    const second = renderHook(() => useReloadNotifications());

    await waitFor(() => {
      expect(second.result.current.pendingReloads.backend).toBe(true);
    });
  });

  it("keeps a safely scheduled reload hidden after consuming its notice", async () => {
    const hook = renderHook(() => useReloadNotifications());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      activityBus.emitLocal("source-change", {
        type: "source-change",
        target: "backend",
        files: ["server.ts"],
        timestamp: "2026-07-05T00:00:00.000Z",
      });
    });
    expect(hook.result.current.pendingReloads.backend).toBe(true);

    act(() => {
      hook.result.current.dismiss("backend");
    });
    await act(async () => {
      await hook.result.current.scheduleSafeRestart();
    });

    expect(hook.result.current.pendingReloads.backend).toBe(false);
  });

  it("allows a fresh notice for changes after the backend reloads", async () => {
    const hook = renderHook(() => useReloadNotifications());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(async () => {
      activityBus.emitLocal("source-change", {
        type: "source-change",
        target: "backend",
        files: ["before-reload.ts"],
        timestamp: "2026-07-05T00:00:00.000Z",
      });
    });
    act(() => {
      hook.result.current.dismiss("backend");
    });

    await act(async () => {
      activityBus.emitLocal("backend-reloaded", undefined);
    });
    await act(async () => {
      activityBus.emitLocal("source-change", {
        type: "source-change",
        target: "backend",
        files: ["after-reload.ts"],
        timestamp: "2026-07-05T00:00:01.000Z",
      });
    });

    expect(hook.result.current.pendingReloads.backend).toBe(true);
  });
});

describe("useReloadNotifications request shape", () => {
  function urlsRequested(): string[] {
    return mockFetchJSON.mock.calls.map((call) => String(call[0]));
  }

  it("reads dev status once on mount, not once per consumer path", async () => {
    const { result } = renderHook(() => useReloadNotifications());
    await waitFor(() => expect(result.current.isManualReloadMode).toBe(true));
    await waitFor(() =>
      expect(result.current.backendReloadSafetyKnown).toBe(true),
    );

    // The mode read used to be followed immediately by a second identical read
    // inside the safety sync it triggered.
    const devStatusReads = urlsRequested().filter(
      (url) => url === "/dev/status",
    );
    expect(devStatusReads).toHaveLength(1);
  });

  it("serves later mounted consumers from the app shell's acquisition", async () => {
    const shell = renderHook(() => useReloadNotifications());
    await waitFor(() =>
      expect(shell.result.current.backendReloadSafetyKnown).toBe(true),
    );

    // Settings and the Development pane mount the hook again. Every fact they
    // display is a property of the source, which the shell has already paid for.
    const settings = renderHook(() => useReloadNotifications());
    const development = renderHook(() => useReloadNotifications());
    await waitFor(() =>
      expect(development.result.current.isManualReloadMode).toBe(true),
    );

    expect(urlsRequested().filter((url) => url === "/dev/status")).toHaveLength(
      1,
    );
    expect(
      urlsRequested().filter((url) => url === "/status/workers"),
    ).toHaveLength(1);
    expect(
      urlsRequested().filter((url) => url === "/dev/safe-restart"),
    ).toHaveLength(1);
    expect(settings.result.current.backendReloadSafetyKnown).toBe(true);

    // And one reconnect costs one read of each, not one per mounted consumer.
    await act(async () => {
      activityBus.emitLocal("reconnect", undefined as never);
    });
    await waitFor(() =>
      expect(
        urlsRequested().filter((url) => url === "/status/workers"),
      ).toHaveLength(2),
    );
    expect(urlsRequested().filter((url) => url === "/dev/status")).toHaveLength(
      2,
    );
    expect(
      urlsRequested().filter((url) => url === "/dev/safe-restart"),
    ).toHaveLength(2);
  });

  it("leaves worker and safe-restart state alone with no reload mode active", async () => {
    mockFetchJSON.mockImplementation(async (url) => {
      if (url === "/dev/status") {
        return {
          noBackendReload: false,
          noFrontendReload: false,
          backendDirty: false,
        } as never;
      }
      return {} as never;
    });

    const { result } = renderHook(() => useReloadNotifications());
    await waitFor(() => expect(result.current.isManualReloadMode).toBe(false));

    act(() => {
      activityBus.emitLocal("reconnect", undefined as never);
      activityBus.emitLocal("refresh", undefined as never);
    });
    await waitFor(() =>
      expect(
        urlsRequested().filter((url) => url === "/dev/status").length,
      ).toBeGreaterThan(1),
    );

    // A deployment in neither reload mode displays none of this, so requesting
    // it merely because the hook is mounted globally is pure server work.
    expect(urlsRequested()).not.toContain("/status/workers");
    expect(urlsRequested()).not.toContain("/dev/safe-restart");
  });

  it("holds connection state without a timer having fired", async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useReloadNotifications());
    const connectedAtMount = result.current.connected;

    // A full second of an interval-driven hook's period, with nothing else
    // pending: the value must not depend on a timer having fired.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });
    expect(result.current.connected).toBe(connectedAtMount);
    expect(result.current.connected).toBe(activityBus.connected);
    vi.useRealTimers();
  });
});
