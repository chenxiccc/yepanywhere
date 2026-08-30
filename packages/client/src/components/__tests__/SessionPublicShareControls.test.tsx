// @vitest-environment jsdom

import type { PublicSessionShareSessionStatusResponse } from "@yep-anywhere/shared";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionPublicShareControls } from "../SessionPublicShareControls";

const mocks = vi.hoisted(() => ({
  getPublicSessionShareStatus: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getPublicSessionShareStatus: mocks.getPublicSessionShareStatus,
  },
}));

function shareStatus(
  activeViewerCount: number,
): PublicSessionShareSessionStatusResponse {
  return {
    activeCount: 1,
    frozenCount: 0,
    liveCount: 1,
    activeViewerCount,
    viewers: [],
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

describe("SessionPublicShareControls", () => {
  it("updates viewer counts below the session-page render boundary", async () => {
    mocks.getPublicSessionShareStatus
      .mockResolvedValueOnce(shareStatus(1))
      .mockResolvedValueOnce(shareStatus(2));
    let parentRenders = 0;

    function SessionPageOwner() {
      parentRenders += 1;
      return (
        <SessionPublicShareControls
          enabled
          projectId="project"
          sessionId="session"
          storageState="ready"
          canCreateShares
          managementAvailable
          modalOpen={false}
          modalAnchorRect={null}
          modalInitialView="session"
          initialPrompt={null}
          title="Session"
          onIndicatorClick={vi.fn()}
          onCloseModal={vi.fn()}
          t={(key, vars) => (vars ? `${key} ${JSON.stringify(vars)}` : key)}
        />
      );
    }

    render(<SessionPageOwner />);
    await settle();
    expect(screen.getByText("1")).toBeDefined();
    expect(parentRenders).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(screen.getByText("2")).toBeDefined();
    expect(parentRenders).toBe(1);
  });
});
