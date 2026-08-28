import { describe, expect, it } from "vitest";
import {
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  getProjectQueueAffordanceState,
  serverSupportsProjectQueue,
  serverSupportsProjectQueueNewSessionShortcutSetting,
} from "../projectQueueVisibility";

describe("serverSupportsProjectQueue", () => {
  it("requires the explicit server capability", () => {
    expect(serverSupportsProjectQueue(null)).toBe(false);
    expect(serverSupportsProjectQueue({ capabilities: [] })).toBe(false);
    expect(
      serverSupportsProjectQueue({
        capabilities: [PROJECT_QUEUE_CAPABILITY],
      }),
    ).toBe(true);
  });

  it("requires current hosted remote compatibility for hosted clients", () => {
    expect(
      serverSupportsProjectQueue(
        { capabilities: [PROJECT_QUEUE_CAPABILITY] },
        { hostedRemote: true },
      ),
    ).toBe(false);
    expect(
      serverSupportsProjectQueue(
        {
          capabilities: [PROJECT_QUEUE_CAPABILITY],
          remoteCompatibilityLevel: 0,
        },
        { hostedRemote: true },
      ),
    ).toBe(false);
    expect(
      serverSupportsProjectQueue(
        {
          capabilities: [PROJECT_QUEUE_CAPABILITY],
          remoteCompatibilityLevel: 10,
        },
        { hostedRemote: true },
      ),
    ).toBe(true);
  });
});

describe("serverSupportsProjectQueueNewSessionShortcutSetting", () => {
  it("requires both Project Queue and the dedicated settings capability", () => {
    expect(
      serverSupportsProjectQueueNewSessionShortcutSetting({
        capabilities: [PROJECT_QUEUE_CAPABILITY],
      }),
    ).toBe(false);
    expect(
      serverSupportsProjectQueueNewSessionShortcutSetting({
        capabilities: [
          PROJECT_QUEUE_CAPABILITY,
          PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
        ],
      }),
    ).toBe(true);
  });
});

describe("getProjectQueueAffordanceState", () => {
  it("is unavailable without a known project", () => {
    expect(getProjectQueueAffordanceState({ projectId: null })).toBe(
      "unavailable",
    );
  });

  it("is unblocked when the project has no blocking work", () => {
    expect(
      getProjectQueueAffordanceState({
        projectId: "project-1",
        activeProjectSessionIds: [],
        projectQueueBlockingCount: 0,
      }),
    ).toBe("unblocked");
  });

  it("is blocked when project queue backlog exists", () => {
    expect(
      getProjectQueueAffordanceState({
        projectId: "project-1",
        projectQueueItemCount: 1,
      }),
    ).toBe("blocked");
  });

  it("is blocked while the current session has active work", () => {
    expect(
      getProjectQueueAffordanceState({
        projectId: "project-1",
        currentSessionBlocksProjectQueue: true,
        activeProjectSessionIds: ["session-1"],
      }),
    ).toBe("blocked");
  });

  it("is blocked while the current session has queued work", () => {
    expect(
      getProjectQueueAffordanceState({
        projectId: "project-1",
        currentSessionHasSessionQueueBacklog: true,
      }),
    ).toBe("blocked");
  });

  it("is blocked when project blocking count reports work", () => {
    expect(
      getProjectQueueAffordanceState({
        projectId: "project-1",
        projectQueueBlockingCount: 1,
      }),
    ).toBe("blocked");
  });

  it("is blocked when another project session is active", () => {
    expect(
      getProjectQueueAffordanceState({
        projectId: "project-1",
        activeProjectSessionIds: ["session-2"],
      }),
    ).toBe("blocked");
  });
});
