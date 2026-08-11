import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PublicSessionShareSessionStatusResponse } from "@yep-anywhere/shared";
import { usePublicSessionShareStatus } from "../usePublicSessionShareStatus";

const mocks = vi.hoisted(() => ({
  getPublicSessionShareStatus: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getPublicSessionShareStatus: mocks.getPublicSessionShareStatus,
  },
}));

function shareStatus(
  overrides: Partial<PublicSessionShareSessionStatusResponse> = {},
): PublicSessionShareSessionStatusResponse {
  return {
    activeCount: 0,
    frozenCount: 0,
    liveCount: 0,
    activeViewerCount: 0,
    viewers: [],
    ...overrides,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.getPublicSessionShareStatus.mockReset();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("usePublicSessionShareStatus", () => {
  it("does not rerender for a structurally unchanged poll response", async () => {
    mocks.getPublicSessionShareStatus.mockImplementation(async () =>
      shareStatus({ activeCount: 1 }),
    );
    let renders = 0;
    const hook = renderHook(() => {
      renders += 1;
      return usePublicSessionShareStatus({
        enabled: true,
        projectId: "project",
        sessionId: "session",
        storageState: "ready",
      });
    });

    await settle();
    expect(hook.result.current.status?.activeCount).toBe(1);
    const rendersAfterInitialStatus = renders;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(mocks.getPublicSessionShareStatus).toHaveBeenCalledTimes(2);
    expect(renders).toBe(rendersAfterInitialStatus);
  });

  it("publishes a changed poll response", async () => {
    mocks.getPublicSessionShareStatus
      .mockResolvedValueOnce(shareStatus({ activeCount: 1 }))
      .mockResolvedValueOnce(shareStatus({ activeCount: 2 }));
    const hook = renderHook(() =>
      usePublicSessionShareStatus({
        enabled: true,
        projectId: "project",
        sessionId: "session",
        storageState: "ready",
      }),
    );

    await settle();
    expect(hook.result.current.status?.activeCount).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(hook.result.current.status?.activeCount).toBe(2);
  });
});
