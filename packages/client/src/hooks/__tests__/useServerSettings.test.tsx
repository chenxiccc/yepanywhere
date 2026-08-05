import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../api/client";
import { resetClientQueryBootstrapForTests } from "../../lib/clientQueryBootstrap";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import {
  asClientSummarySourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import {
  resetServerSettingsForTests,
  useServerSettings,
} from "../useServerSettings";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>();
  const getServerSettings = vi.fn();
  const updateServerSettings = vi.fn();
  const sourceFetch = vi.fn(
    (sourceKey: string, path: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (path === "/settings" && method === "GET") {
        return getServerSettings();
      }
      if (path === "/settings" && method === "PUT") {
        return updateServerSettings(
          JSON.parse(typeof init?.body === "string" ? init.body : "{}"),
        );
      }
      throw new Error(`Unexpected ${method} ${path} for ${sourceKey}`);
    },
  );
  const getOrCreateSourceRuntime = vi.fn((sourceKey: string) => ({
    sourceKey,
    transport: {
      fetch: (path: string, init?: RequestInit) =>
        sourceFetch(sourceKey, path, init),
    },
  }));
  return {
    getServerSettings,
    updateServerSettings,
    sourceFetch,
    getOrCreateSourceRuntime,
    isRemoteClient: vi.fn(() => false),
    remoteState: {
      connection: null as { connection: object | null } | null,
    },
    activityBus: {
      on: vi.fn((event: string, handler: () => void) => {
        let set = handlers.get(event);
        if (!set) {
          set = new Set();
          handlers.set(event, set);
        }
        set.add(handler);
        return () => handlers.get(event)?.delete(handler);
      }),
      emit(event: string) {
        for (const handler of handlers.get(event) ?? []) {
          handler();
        }
      },
      reset() {
        handlers.clear();
      },
    },
  };
});

vi.mock("../../lib/sourceRuntime", () => ({
  getSourceRuntimeRegistry: () => ({
    getOrCreateSourceRuntime: mocks.getOrCreateSourceRuntime,
  }),
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: { on: mocks.activityBus.on },
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: mocks.isRemoteClient,
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => mocks.remoteState.connection,
}));

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function settings(overrides: Partial<ServerSettings> = {}): ServerSettings {
  return {
    serviceWorkerEnabled: true,
    persistRemoteSessionsToDisk: false,
    publicSharesEnabled: false,
    ...overrides,
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetClientSummaryStoreForTests();
  resetClientQueryControllerForTests();
  resetClientQueryBootstrapForTests();
  resetServerSettingsForTests();
  mocks.getServerSettings.mockReset();
  mocks.updateServerSettings.mockReset();
  mocks.sourceFetch.mockClear();
  mocks.getOrCreateSourceRuntime.mockClear();
  mocks.getServerSettings.mockResolvedValue({ settings: settings() });
  mocks.updateServerSettings.mockResolvedValue({ settings: settings() });
  mocks.isRemoteClient.mockReset();
  mocks.isRemoteClient.mockReturnValue(false);
  mocks.remoteState.connection = null;
  mocks.activityBus.reset();
  mocks.activityBus.on.mockClear();
});

afterEach(() => {
  cleanup();
  resetServerSettingsForTests();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  vi.useRealTimers();
});

describe("useServerSettings", () => {
  it("shares the initial settings fetch across mounted consumers", async () => {
    mocks.getServerSettings.mockResolvedValue({
      settings: settings({ publicSharesEnabled: true }),
    });

    const first = renderHook(() => useServerSettings());
    const second = renderHook(() => useServerSettings());

    await settle();

    expect(mocks.getServerSettings).toHaveBeenCalledTimes(1);
    expect(first.result.current.isLoading).toBe(false);
    expect(second.result.current.isLoading).toBe(false);
    expect(first.result.current.settings?.publicSharesEnabled).toBe(true);
    expect(second.result.current.settings?.publicSharesEnabled).toBe(true);
  });

  it("coalesces refresh and reconnect across mounted consumers", async () => {
    const revalidation = deferred<{ settings: ServerSettings }>();
    mocks.getServerSettings
      .mockResolvedValueOnce({
        settings: settings({ publicSharesEnabled: false }),
      })
      .mockReturnValueOnce(revalidation.promise);

    const first = renderHook(() => useServerSettings());
    const second = renderHook(() => useServerSettings());
    await settle();
    expect(mocks.getServerSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.activityBus.emit("refresh");
      mocks.activityBus.emit("reconnect");
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(mocks.getServerSettings).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getServerSettings).toHaveBeenCalledTimes(2);

    revalidation.resolve({
      settings: settings({ publicSharesEnabled: true }),
    });
    await settle();

    expect(first.result.current.settings?.publicSharesEnabled).toBe(true);
    expect(second.result.current.settings?.publicSharesEnabled).toBe(true);
  });

  it("waits for remote connection readiness before fetching", async () => {
    mocks.isRemoteClient.mockReturnValue(true);
    mocks.remoteState.connection = null;

    const hook = renderHook(() => useServerSettings());

    await settle();
    expect(mocks.getServerSettings).not.toHaveBeenCalled();
    expect(hook.result.current.isLoading).toBe(true);

    act(() => {
      setCurrentClientSummarySourceKey(asClientSummarySourceKey("direct:ws"));
    });
    mocks.remoteState.connection = { connection: {} };
    hook.rerender();

    await settle();
    expect(mocks.getServerSettings).toHaveBeenCalledTimes(1);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it("waits for remote source selection before fetching", async () => {
    mocks.isRemoteClient.mockReturnValue(true);
    mocks.remoteState.connection = { connection: {} };

    const hook = renderHook(() => useServerSettings());

    await settle();
    expect(mocks.getServerSettings).not.toHaveBeenCalled();
    expect(hook.result.current.isLoading).toBe(true);

    act(() => {
      setCurrentClientSummarySourceKey(asClientSummarySourceKey("direct:ws"));
    });
    await settle();

    expect(mocks.getServerSettings).toHaveBeenCalledTimes(1);
    expect(hook.result.current.isLoading).toBe(false);
  });

  it("fetches with the query source when the current source changes", async () => {
    const remoteSource = asClientSummarySourceKey("direct:ws");
    mocks.isRemoteClient.mockReturnValue(true);
    mocks.remoteState.connection = { connection: {} };

    act(() => {
      setCurrentClientSummarySourceKey(remoteSource);
    });
    renderHook(() => useServerSettings());
    // Let the acquisition start before the source moves under it: the point
    // being pinned is which source the request was issued for, and a startup
    // tier defers that start by a microtask.
    await settle();

    act(() => {
      setCurrentClientSummarySourceKey(LOCAL_CLIENT_SUMMARY_SOURCE_KEY);
    });
    await settle();

    expect(mocks.sourceFetch).toHaveBeenCalledWith(
      remoteSource,
      "/settings",
      undefined,
    );
    expect(mocks.sourceFetch).not.toHaveBeenCalledWith(
      LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
      "/settings",
      undefined,
    );
  });

  it("writes mutation responses into the shared settings snapshot", async () => {
    mocks.getServerSettings.mockResolvedValue({
      settings: settings({ publicSharesEnabled: false }),
    });
    mocks.updateServerSettings.mockResolvedValue({
      settings: settings({ publicSharesEnabled: true }),
    });

    const first = renderHook(() => useServerSettings());
    const second = renderHook(() => useServerSettings());
    await settle();

    await act(async () => {
      await first.result.current.updateSettings({ publicSharesEnabled: true });
    });

    expect(mocks.updateServerSettings).toHaveBeenCalledWith({
      publicSharesEnabled: true,
    });
    expect(first.result.current.settings?.publicSharesEnabled).toBe(true);
    expect(second.result.current.settings?.publicSharesEnabled).toBe(true);
  });

  it("does not let an older GET overwrite a newer mutation response", async () => {
    const initialRequest = deferred<{ settings: ServerSettings }>();
    mocks.getServerSettings.mockReturnValueOnce(initialRequest.promise);
    mocks.updateServerSettings.mockResolvedValue({
      settings: settings({ publicSharesEnabled: true }),
    });

    const hook = renderHook(() => useServerSettings());
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.getServerSettings).toHaveBeenCalledTimes(1);

    vi.setSystemTime(10);
    await act(async () => {
      await hook.result.current.updateSettings({ publicSharesEnabled: true });
    });
    expect(hook.result.current.settings?.publicSharesEnabled).toBe(true);

    initialRequest.resolve({
      settings: settings({ publicSharesEnabled: false }),
    });
    await settle();

    expect(hook.result.current.settings?.publicSharesEnabled).toBe(true);
  });
});
