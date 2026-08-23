import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicShareStatusResponse } from "../../api/client";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import { resetClientSummaryStoreForTests } from "../../lib/clientSummaryStore";
import {
  resetPublicShareStatusForTests,
  usePublicShareStatus,
} from "../usePublicShareStatus";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>();
  return {
    getPublicShareStatus: vi.fn(),
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

vi.mock("../../api/client", () => ({
  api: {
    getPublicShareStatus: mocks.getPublicShareStatus,
  },
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

function shareStatus(
  overrides: Partial<PublicShareStatusResponse> = {},
): PublicShareStatusResponse {
  return {
    enabled: true,
    configured: true,
    requiresRelay: false,
    remoteAccessEnabled: true,
    relayStatus: null,
    canCreate: true,
    yaClientBaseUrl: null,
    defaultYaClientBaseUrl: "https://example.test",
    viewerBaseUrl: null,
    defaultViewerBaseUrl: "https://example.test",
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
  resetPublicShareStatusForTests();
  mocks.getPublicShareStatus.mockReset();
  mocks.getPublicShareStatus.mockResolvedValue(shareStatus());
  mocks.isRemoteClient.mockReset();
  mocks.isRemoteClient.mockReturnValue(false);
  mocks.remoteState.connection = null;
  mocks.activityBus.reset();
  mocks.activityBus.on.mockClear();
});

afterEach(() => {
  cleanup();
  resetPublicShareStatusForTests();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  vi.useRealTimers();
});

describe("usePublicShareStatus", () => {
  it("shares the initial status fetch across mounted consumers", async () => {
    mocks.getPublicShareStatus.mockResolvedValue(
      shareStatus({ canCreate: true }),
    );

    const first = renderHook(() => usePublicShareStatus());
    const second = renderHook(() => usePublicShareStatus());

    await settle();

    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(1);
    expect(first.result.current.loading).toBe(false);
    expect(second.result.current.loading).toBe(false);
    expect(first.result.current.status?.canCreate).toBe(true);
    expect(second.result.current.status?.canCreate).toBe(true);
  });

  it("uses one polling owner across mounted consumers", async () => {
    const firstPoll = deferred<PublicShareStatusResponse>();
    const secondPoll = deferred<PublicShareStatusResponse>();
    mocks.getPublicShareStatus
      .mockResolvedValueOnce(shareStatus({ canCreate: false }))
      .mockReturnValueOnce(firstPoll.promise)
      .mockReturnValueOnce(secondPoll.promise);

    const first = renderHook(() => usePublicShareStatus({ poll: true }));
    const second = renderHook(() => usePublicShareStatus({ poll: true }));
    await settle();

    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4999);
    });
    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(2);

    firstPoll.resolve(shareStatus({ canCreate: true }));
    await settle();
    expect(first.result.current.status?.canCreate).toBe(true);
    expect(second.result.current.status?.canCreate).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(3);

    secondPoll.resolve(shareStatus({ canCreate: false }));
    await settle();
    expect(first.result.current.status?.canCreate).toBe(false);
    expect(second.result.current.status?.canCreate).toBe(false);
  });

  it("retains the snapshot when a poll returns equal status", async () => {
    const status = shareStatus({ canCreate: true });
    mocks.getPublicShareStatus.mockResolvedValue(status);

    const hook = renderHook(() => usePublicShareStatus({ poll: true }));
    await settle();
    const initialSnapshot = hook.result.current.status;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    await settle();

    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(2);
    expect(hook.result.current.status).toBe(initialSnapshot);
  });

  it("coalesces refresh and reconnect across mounted consumers", async () => {
    const revalidation = deferred<PublicShareStatusResponse>();
    mocks.getPublicShareStatus
      .mockResolvedValueOnce(shareStatus({ canCreate: false }))
      .mockReturnValueOnce(revalidation.promise);

    const first = renderHook(() => usePublicShareStatus());
    const second = renderHook(() => usePublicShareStatus());
    await settle();
    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.activityBus.emit("refresh");
      mocks.activityBus.emit("reconnect");
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(2);

    revalidation.resolve(shareStatus({ canCreate: true }));
    await settle();

    expect(first.result.current.status?.canCreate).toBe(true);
    expect(second.result.current.status?.canCreate).toBe(true);
  });

  it("waits for remote connection readiness before fetching", async () => {
    mocks.isRemoteClient.mockReturnValue(true);
    mocks.remoteState.connection = null;

    const hook = renderHook(() => usePublicShareStatus({ poll: true }));

    await settle();
    expect(mocks.getPublicShareStatus).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(true);

    mocks.remoteState.connection = { connection: {} };
    hook.rerender();

    await settle();
    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(2);
  });

  it("cleans up the shared poll timer when consumers unmount", async () => {
    const first = renderHook(() => usePublicShareStatus({ poll: true }));
    const second = renderHook(() => usePublicShareStatus({ poll: true }));
    await settle();
    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(1);

    first.unmount();
    second.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mocks.getPublicShareStatus).toHaveBeenCalledTimes(1);
  });
});
