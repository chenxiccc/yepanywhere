import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VersionInfo } from "../../api/client";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import {
  asClientSummarySourceKey,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import { resetVersionSnapshotsForTests, useVersion } from "../useVersion";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<() => void>>();
  return {
    getVersion: vi.fn(),
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
  api: { getVersion: mocks.getVersion },
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

const SOURCE_A = asClientSummarySourceKey("host:a");
const SOURCE_B = asClientSummarySourceKey("host:b");

function versionInfo(overrides: Partial<VersionInfo> = {}): VersionInfo {
  return {
    current: "1.0.0",
    latest: null,
    updateAvailable: false,
    ...overrides,
  };
}

function pendingSpeechVersion(
  validationStatus: "pending" | "enabled" = "pending",
): VersionInfo {
  return versionInfo({
    voiceBackendStatuses: [
      { id: "whisper", label: "Whisper", enabled: true, validationStatus },
    ],
  });
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
  resetVersionSnapshotsForTests();
  setCurrentClientSummarySourceKey(SOURCE_A);
  mocks.getVersion.mockReset();
  mocks.getVersion.mockResolvedValue(versionInfo());
  mocks.isRemoteClient.mockReset();
  mocks.isRemoteClient.mockReturnValue(false);
  mocks.remoteState.connection = null;
  mocks.activityBus.reset();
  mocks.activityBus.on.mockClear();
});

afterEach(() => {
  cleanup();
  resetVersionSnapshotsForTests();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  vi.useRealTimers();
});

describe("useVersion", () => {
  it("shares one request across simultaneously mounted consumers", async () => {
    mocks.getVersion.mockResolvedValue(versionInfo({ current: "9.9.9" }));

    const first = renderHook(() => useVersion());
    const second = renderHook(() => useVersion());
    const third = renderHook(() => useVersion());
    await settle();

    expect(mocks.getVersion).toHaveBeenCalledTimes(1);
    for (const hook of [first, second, third]) {
      expect(hook.result.current.version?.current).toBe("9.9.9");
      expect(hook.result.current.loading).toBe(false);
    }
  });

  it("issues no request when a consumer mounts after the snapshot resolves", async () => {
    renderHook(() => useVersion());
    await settle();
    expect(mocks.getVersion).toHaveBeenCalledTimes(1);

    const late = renderHook(() => useVersion());
    await settle();

    expect(mocks.getVersion).toHaveBeenCalledTimes(1);
    expect(late.result.current.version?.current).toBe("1.0.0");
    // The retained snapshot is already present, so a late consumer must not
    // flash a loading state that no request backs.
    expect(late.result.current.loading).toBe(false);
  });

  it("keeps one source's snapshot from answering another source", async () => {
    mocks.getVersion
      .mockResolvedValueOnce(versionInfo({ current: "1.0.0" }))
      .mockResolvedValueOnce(versionInfo({ current: "2.0.0" }));

    const hook = renderHook(() => useVersion());
    await settle();
    expect(hook.result.current.version?.current).toBe("1.0.0");

    await act(async () => {
      setCurrentClientSummarySourceKey(SOURCE_B);
    });
    await settle();

    expect(mocks.getVersion).toHaveBeenCalledTimes(2);
    expect(hook.result.current.version?.current).toBe("2.0.0");

    await act(async () => {
      setCurrentClientSummarySourceKey(SOURCE_A);
    });
    await settle();

    expect(mocks.getVersion).toHaveBeenCalledTimes(2);
    expect(hook.result.current.version?.current).toBe("1.0.0");
  });

  it("retains one pending-speech follow-up across consumers", async () => {
    mocks.getVersion.mockResolvedValue(pendingSpeechVersion());

    renderHook(() => useVersion());
    renderHook(() => useVersion());
    renderHook(() => useVersion());
    await settle();
    expect(mocks.getVersion).toHaveBeenCalledTimes(1);

    // Three mounted consumers, one follow-up — not three.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.getVersion).toHaveBeenCalledTimes(2);

    mocks.getVersion.mockResolvedValue(pendingSpeechVersion("enabled"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(mocks.getVersion).toHaveBeenCalledTimes(3);

    // Settled backends stop the follow-up entirely.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.getVersion).toHaveBeenCalledTimes(3);
  });

  it("stops the pending follow-up when every consumer unmounts", async () => {
    mocks.getVersion.mockResolvedValue(pendingSpeechVersion());

    const first = renderHook(() => useVersion());
    const second = renderHook(() => useVersion());
    await settle();
    expect(mocks.getVersion).toHaveBeenCalledTimes(1);

    first.unmount();
    second.unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(mocks.getVersion).toHaveBeenCalledTimes(1);
  });

  it("coalesces reconnect revalidation across consumers", async () => {
    // An instantly-resolving response is deliberate: it is the case that used
    // to cost two round trips, because each hook owned a debounce timer and the
    // first revalidation completed before the second timer fired. One owner per
    // (source, query) now makes it one.
    mocks.getVersion.mockResolvedValue(versionInfo({ current: "1.0.0" }));

    const first = renderHook(() => useVersion());
    const second = renderHook(() => useVersion());
    await settle();
    expect(mocks.getVersion).toHaveBeenCalledTimes(1);

    mocks.getVersion.mockResolvedValue(versionInfo({ current: "3.0.0" }));
    await act(async () => {
      mocks.activityBus.emit("reconnect");
      await vi.advanceTimersByTimeAsync(500);
    });
    await settle();

    expect(mocks.getVersion).toHaveBeenCalledTimes(2);
    expect(mocks.getVersion).toHaveBeenLastCalledWith({ fresh: false });
    expect(first.result.current.version?.current).toBe("3.0.0");
    expect(second.result.current.version?.current).toBe("3.0.0");
  });

  it("makes freshOnMount an update check rather than a second ordinary read", async () => {
    const about = renderHook(() => useVersion({ freshOnMount: true }));
    await settle();

    expect(mocks.getVersion).toHaveBeenCalledTimes(1);
    expect(mocks.getVersion).toHaveBeenCalledWith({ fresh: true });
    expect(about.result.current.version?.current).toBe("1.0.0");
  });

  it("does not let an in-flight ordinary read satisfy an update check", async () => {
    renderHook(() => useVersion());
    const about = renderHook(() => useVersion({ freshOnMount: true }));
    await settle();

    expect(mocks.getVersion).toHaveBeenCalledTimes(2);
    expect(mocks.getVersion).toHaveBeenNthCalledWith(1, { fresh: false });
    expect(mocks.getVersion).toHaveBeenNthCalledWith(2, { fresh: true });
    expect(about.result.current.version).not.toBeNull();
  });

  it("resolves refetchFresh with the checked snapshot and shares it", async () => {
    const ordinary = renderHook(() => useVersion());
    await settle();
    expect(mocks.getVersion).toHaveBeenCalledTimes(1);

    mocks.getVersion.mockResolvedValue(
      versionInfo({ current: "1.0.0", latest: "1.1.0", updateAvailable: true }),
    );

    let checked: VersionInfo | null = null;
    await act(async () => {
      checked = await ordinary.result.current.refetchFresh();
    });

    expect(mocks.getVersion).toHaveBeenLastCalledWith({ fresh: true });
    expect(checked).not.toBeNull();
    expect((checked as unknown as VersionInfo).updateAvailable).toBe(true);
    // The check publishes into the same retained snapshot every consumer reads.
    expect(ordinary.result.current.version?.updateAvailable).toBe(true);
  });

  it("starts no request before remote connection readiness", async () => {
    mocks.isRemoteClient.mockReturnValue(true);
    mocks.remoteState.connection = null;

    const hook = renderHook(() => useVersion());
    await settle();

    expect(mocks.getVersion).not.toHaveBeenCalled();
    expect(hook.result.current.loading).toBe(true);

    mocks.remoteState.connection = { connection: {} };
    hook.rerender();
    await settle();

    expect(mocks.getVersion).toHaveBeenCalledTimes(1);
  });
});
