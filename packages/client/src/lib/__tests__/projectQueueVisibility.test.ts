import { describe, expect, it } from "vitest";
import {
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  serverSupportsProjectQueue,
  serverSupportsProjectQueueNewSessionShortcutSetting,
  shouldShowProjectQueueAffordance,
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

describe("shouldShowProjectQueueAffordance", () => {
  it("hides without a known project", () => {
    expect(shouldShowProjectQueueAffordance({ projectId: null })).toBe(false);
  });

  it("shows when project queue backlog exists", () => {
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        projectQueueItemCount: 1,
      }),
    ).toBe(true);
  });

  it("hides when normal send is equivalent", () => {
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        currentSessionId: "session-1",
        activeProjectSessionIds: [],
      }),
    ).toBe(false);
  });

  it("hides when normal session queue is equivalent", () => {
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        currentSessionId: "session-1",
        activeProjectSessionIds: ["session-1"],
      }),
    ).toBe(false);
  });

  it("hides when project blocking count only reflects the current session", () => {
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        currentSessionId: "session-1",
        currentSessionBlocksProjectQueue: true,
        projectQueueBlockingCount: 1,
      }),
    ).toBe(false);
  });

  it("hides when the project has no queue-blocking work", () => {
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        currentSessionId: "session-1",
        activeProjectSessionIds: [],
        projectQueueBlockingCount: 0,
      }),
    ).toBe(false);
  });

  it("shows when the current active session already has backlog", () => {
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        currentSessionId: "session-1",
        currentSessionHasSessionQueueBacklog: true,
        activeProjectSessionIds: ["session-1"],
      }),
    ).toBe(true);
  });

  it("shows when project blocking count indicates another blocker", () => {
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        currentSessionId: "session-1",
        currentSessionBlocksProjectQueue: false,
        projectQueueBlockingCount: 1,
      }),
    ).toBe(true);
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        currentSessionId: "session-1",
        currentSessionBlocksProjectQueue: true,
        projectQueueBlockingCount: 2,
      }),
    ).toBe(true);
  });

  it("shows when other project sessions are active", () => {
    expect(
      shouldShowProjectQueueAffordance({
        projectId: "project-1",
        currentSessionId: "session-1",
        activeProjectSessionIds: ["session-2"],
      }),
    ).toBe(true);
  });
});
