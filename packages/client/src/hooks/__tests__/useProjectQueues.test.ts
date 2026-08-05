// @vitest-environment jsdom

import type {
  ProjectQueueItemSummary,
  ProjectQueueProjectStatus,
  ProjectQueueRecoveredSessionQueueSummary,
} from "@yep-anywhere/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const busMock = vi.hoisted(() => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>();
  return {
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      let set = handlers.get(event);
      if (!set) {
        set = new Set();
        handlers.set(event, set);
      }
      set.add(handler);
      return () => handlers.get(event)?.delete(handler);
    }),
    emit(event: string, payload?: unknown) {
      for (const handler of handlers.get(event) ?? []) handler(payload);
    },
    reset() {
      handlers.clear();
    },
  };
});

const apiMock = vi.hoisted(() => ({
  getProjectQueue: vi.fn(),
  getProjectQueueItems: vi.fn(),
  updateProjectQueueItem: vi.fn(),
  deleteProjectQueueItem: vi.fn(),
  retryProjectQueueItem: vi.fn(),
  moveProjectQueueItemToTop: vi.fn(),
  pauseProjectQueueDispatch: vi.fn(),
  resumeProjectQueueDispatch: vi.fn(),
  promoteProjectQueueNow: vi.fn(),
}));
const versionMock = vi.hoisted(() => ({
  version: { capabilities: [] as string[] } as {
    capabilities?: string[];
    remoteCompatibilityLevel?: number;
  },
}));
const connectionMock = vi.hoisted(() => ({
  isRemoteClient: vi.fn(() => false),
  remoteState: {
    connection: null as { connection: object | null } | null,
  },
}));

vi.mock("../../api/client", () => ({
  api: apiMock,
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: busMock.on,
    onSource: (
      _sourceKey: string,
      event: string,
      handler: (payload: unknown) => void,
    ) => busMock.on(event, handler),
    retainSourceStream: vi.fn(() => () => {}),
  },
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: connectionMock.isRemoteClient,
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => connectionMock.remoteState.connection,
}));

vi.mock("../useVersion", () => ({
  useVersion: () => ({ version: versionMock.version }),
}));

import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import { resetClientSummaryStoreForTests } from "../../lib/clientSummaryStore";
import { PROJECT_QUEUE_CAPABILITY } from "../../lib/projectQueueVisibility";
import {
  resetProjectQueueBackstopsForTests,
  useProjectQueues,
} from "../useProjectQueues";

const PROJECT_ID = "project-1" as ProjectQueueItemSummary["projectId"];
const PROJECT_ID_2 = "project-2" as ProjectQueueItemSummary["projectId"];

function makeItem(
  id: string,
  projectId: ProjectQueueItemSummary["projectId"] = PROJECT_ID,
  status: ProjectQueueItemSummary["status"] = "queued",
): ProjectQueueItemSummary {
  return {
    id,
    projectId,
    target: { type: "existing-session", sessionId: "session-1" },
    messagePreview: `Message ${id}`,
    message: { text: `Message ${id}` },
    createdAt: `2026-06-27T00:00:0${id}.000Z`,
    updatedAt: `2026-06-27T00:00:0${id}.000Z`,
    status,
    attachmentCount: 0,
  };
}

function makeRecoveredSessionQueue(
  id: string,
  projectId: ProjectQueueRecoveredSessionQueueSummary["projectId"] = PROJECT_ID,
): ProjectQueueRecoveredSessionQueueSummary {
  return {
    id,
    tempId: `temp-${id}`,
    sessionId: `session-${id}`,
    projectId,
    content: `Recovered ${id}`,
    timestamp: `2026-06-30T00:00:0${id}.000Z`,
    queuedAt: `2026-06-30T00:00:0${id}.000Z`,
    createdAt: `2026-06-30T00:00:0${id}.000Z`,
    updatedAt: `2026-06-30T00:00:0${id}.000Z`,
    kind: "patient",
    status: "paused-after-restart",
  };
}

function makeProjectStatus(
  state: ProjectQueueProjectStatus["state"],
): ProjectQueueProjectStatus {
  return {
    projectId: PROJECT_ID,
    state,
    idle: state !== "blocked",
    blockers: state === "blocked" ? ["session-1:in-turn"] : [],
    dispatchPaused: state === "paused",
    inFlight: state === "dispatching",
    quietWindowMs: 30_000,
    itemCount: 1,
    nextItemId: "1",
  };
}

beforeEach(() => {
  resetClientSummaryStoreForTests();
  resetClientQueryControllerForTests();
  versionMock.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
  busMock.reset();
  busMock.on.mockClear();
  apiMock.getProjectQueue.mockReset();
  apiMock.getProjectQueueItems.mockReset();
  apiMock.updateProjectQueueItem.mockReset();
  apiMock.deleteProjectQueueItem.mockReset();
  apiMock.retryProjectQueueItem.mockReset();
  apiMock.moveProjectQueueItemToTop.mockReset();
  apiMock.pauseProjectQueueDispatch.mockReset();
  apiMock.resumeProjectQueueDispatch.mockReset();
  apiMock.promoteProjectQueueNow.mockReset();
  connectionMock.isRemoteClient.mockReset();
  connectionMock.isRemoteClient.mockReturnValue(false);
  connectionMock.remoteState.connection = null;
});

afterEach(() => {
  cleanup();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
});

describe("useProjectQueues", () => {
  it("stays idle without the project queue server capability", async () => {
    versionMock.version = { capabilities: [] };

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiMock.getProjectQueue).not.toHaveBeenCalled();
    expect(apiMock.getProjectQueueItems).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
  });

  it("stays idle for hosted remote servers below the compatible level", async () => {
    connectionMock.isRemoteClient.mockReturnValue(true);
    versionMock.version = {
      capabilities: [PROJECT_QUEUE_CAPABILITY],
      remoteCompatibilityLevel: 0,
    };

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiMock.getProjectQueue).not.toHaveBeenCalled();
    expect(apiMock.getProjectQueueItems).not.toHaveBeenCalled();
    expect(result.current.items).toEqual([]);
  });

  it("fetches all queue items once for the supplied projects", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID), makeItem("2", PROJECT_ID_2)],
      projectStatuses: { [PROJECT_ID]: makeProjectStatus("waiting-quiet") },
    });

    const { result } = renderHook(() =>
      useProjectQueues(["project-1", "project-2"]),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    expect(apiMock.getProjectQueue).not.toHaveBeenCalled();
    expect(result.current.items.map((item) => item.id)).toEqual(["1", "2"]);
    expect(result.current.projectStatusesByProject[PROJECT_ID]).toMatchObject({
      state: "waiting-quiet",
      nextItemId: "1",
    });
  });

  it("exposes recovered session queues for the supplied projects", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [],
      recoveredSessionQueues: [
        makeRecoveredSessionQueue("1", PROJECT_ID),
        makeRecoveredSessionQueue("2", PROJECT_ID_2),
      ],
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.recoveredSessionQueues).toMatchObject([
      {
        id: "1",
        projectId: PROJECT_ID,
        content: "Recovered 1",
        status: "paused-after-restart",
      },
    ]);
  });

  it("shares dispatch state with consumers that reuse a fresh query", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      dispatchState: {
        status: "paused",
        reason: "restart",
        pausedAt: "2026-07-01T07:41:12.926Z",
      },
      recoveredSessionQueues: [makeRecoveredSessionQueue("1", PROJECT_ID)],
      projectStatuses: {
        [PROJECT_ID]: makeProjectStatus("waiting-quiet"),
      },
    });

    const first = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() =>
      expect(first.result.current.dispatchState).toMatchObject({
        status: "paused",
        reason: "restart",
      }),
    );

    const second = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(second.result.current.loading).toBe(false));

    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
    expect(second.result.current.dispatchState).toMatchObject({
      status: "paused",
      reason: "restart",
    });
    expect(
      second.result.current.recoveredSessionQueues.map((item) => item.id),
    ).toEqual(["1"]);
    expect(
      second.result.current.projectStatusesByProject[PROJECT_ID],
    ).toMatchObject({
      state: "waiting-quiet",
      nextItemId: "1",
    });
  });

  it("refetches recovered session queues after persistence changes", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [],
        recoveredSessionQueues: [makeRecoveredSessionQueue("1", PROJECT_ID)],
      })
      .mockResolvedValueOnce({
        items: [],
        recoveredSessionQueues: [makeRecoveredSessionQueue("3", PROJECT_ID)],
      });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() =>
      expect(
        result.current.recoveredSessionQueues.map((item) => item.id),
      ).toEqual(["1"]),
    );

    act(() => {
      busMock.emit("session-queue-persistence-changed", {
        type: "session-queue-persistence-changed",
        timestamp: "2026-06-30T00:00:10.000Z",
      });
    });

    await waitFor(
      () => expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2),
      { timeout: 1500 },
    );
    await waitFor(() =>
      expect(
        result.current.recoveredSessionQueues.map((item) => item.id),
      ).toEqual(["3"]),
    );
  });

  it("shares manual refetches across mounted consumers", async () => {
    apiMock.getProjectQueueItems
      .mockResolvedValueOnce({
        items: [makeItem("1", PROJECT_ID)],
      })
      .mockResolvedValueOnce({
        items: [makeItem("2", PROJECT_ID)],
      });

    const first = renderHook(() => useProjectQueues(["project-1"]));
    const second = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(first.result.current.loading).toBe(false));
    await waitFor(() => expect(second.result.current.loading).toBe(false));
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await Promise.all([
        first.result.current.refetch(),
        second.result.current.refetch(),
      ]);
    });

    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
    expect(first.result.current.items.map((item) => item.id)).toEqual(["2"]);
    expect(second.result.current.items.map((item) => item.id)).toEqual(["2"]);
  });

  it("updates a project queue from activity events", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));

    act(() => {
      busMock.emit("project-queue-changed", {
        type: "project-queue-changed",
        projectId: PROJECT_ID,
        items: [makeItem("2", PROJECT_ID, "failed")],
        reason: "failed",
        timestamp: "2026-06-27T00:00:10.000Z",
      });
    });

    await waitFor(() =>
      expect(result.current.items).toMatchObject([
        { id: "2", status: "failed" },
      ]),
    );
  });

  it("replaces state from delete and retry responses", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
    });
    apiMock.deleteProjectQueueItem.mockResolvedValue({
      deleted: true,
      queue: { projectId: PROJECT_ID, items: [] },
    });
    apiMock.retryProjectQueueItem.mockResolvedValue({
      item: makeItem("2", PROJECT_ID),
      queue: { projectId: PROJECT_ID, items: [makeItem("2", PROJECT_ID)] },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.deleteItem("project-1", "1");
    });

    expect(apiMock.deleteProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      "1",
    );
    await waitFor(() => expect(result.current.items).toEqual([]));

    await act(async () => {
      await result.current.retryItem("project-1", "2");
    });

    expect(apiMock.retryProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      "2",
    );
    expect(result.current.items.map((item) => item.id)).toEqual(["2"]);
  });

  it("replaces state from update responses", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
    });
    apiMock.updateProjectQueueItem.mockResolvedValue({
      item: makeItem("1", PROJECT_ID),
      queue: {
        projectId: PROJECT_ID,
        items: [
          {
            ...makeItem("1", PROJECT_ID),
            messagePreview: "Edited message",
            message: { text: "Edited message" },
          },
        ],
      },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.updateItem("project-1", "1", {
        message: { text: "Edited message" },
      });
    });

    expect(apiMock.updateProjectQueueItem).toHaveBeenCalledWith(
      "project-1",
      "1",
      { message: { text: "Edited message" } },
    );
    expect(result.current.items).toMatchObject([
      { id: "1", messagePreview: "Edited message" },
    ]);
  });

  it("preserves queue order from move-to-top responses", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1"), makeItem("2")],
    });
    apiMock.moveProjectQueueItemToTop.mockResolvedValue({
      item: makeItem("2", PROJECT_ID),
      queue: {
        projectId: PROJECT_ID,
        items: [makeItem("2", PROJECT_ID), makeItem("1", PROJECT_ID)],
      },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.moveItemToTop("project-1", "2");
    });

    expect(apiMock.moveProjectQueueItemToTop).toHaveBeenCalledWith(
      "project-1",
      "2",
    );
    expect(result.current.items.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("keeps project-local move-to-top while paused", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID), makeItem("2", PROJECT_ID)],
      dispatchState: {
        status: "paused",
        reason: "manual",
        pausedAt: "2026-06-30T00:00:00.000Z",
      },
    });
    apiMock.moveProjectQueueItemToTop.mockResolvedValue({
      item: makeItem("2", PROJECT_ID),
      queue: {
        projectId: PROJECT_ID,
        items: [makeItem("2", PROJECT_ID), makeItem("1", PROJECT_ID)],
      },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.moveItemToTop("project-1", "2");
    });

    expect(apiMock.moveProjectQueueItemToTop).toHaveBeenCalledWith(
      "project-1",
      "2",
    );
    expect(result.current.items.map((item) => item.id)).toEqual(["2", "1"]);
  });

  it("updates dispatch state from pause and resume responses", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
      dispatchState: { status: "running" },
    });
    apiMock.pauseProjectQueueDispatch.mockResolvedValue({
      items: [makeItem("1")],
      dispatchState: {
        status: "paused",
        reason: "manual",
        pausedAt: "2026-06-30T00:00:00.000Z",
      },
    });
    apiMock.resumeProjectQueueDispatch.mockResolvedValue({
      items: [makeItem("1")],
      dispatchState: { status: "running" },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.pauseDispatch();
    });

    expect(result.current.dispatchState).toMatchObject({
      status: "paused",
      reason: "manual",
    });

    await act(async () => {
      await result.current.resumeDispatch();
    });

    expect(result.current.dispatchState).toEqual({ status: "running" });
  });

  it("promotes a specific project queue item with optional force", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1")],
      projectStatuses: { [PROJECT_ID]: makeProjectStatus("blocked") },
    });
    apiMock.promoteProjectQueueNow.mockResolvedValue({
      items: [],
      dispatchState: { status: "running" },
      projectStatuses: { [PROJECT_ID]: makeProjectStatus("empty") },
      promoteResult: {
        promoted: true,
        itemId: "1",
        sessionId: "session-1",
        reason: "promoted",
        status: makeProjectStatus("empty"),
      },
    });

    const { result } = renderHook(() => useProjectQueues(["project-1"]));

    await waitFor(() => expect(result.current.items).toHaveLength(1));
    await act(async () => {
      await result.current.promoteNow("project-1", "1", {
        force: true,
        deliveryIntent: "steer",
      });
    });

    expect(apiMock.promoteProjectQueueNow).toHaveBeenCalledWith("project-1", {
      itemId: "1",
      force: true,
      deliveryIntent: "steer",
    });
    expect(result.current.items).toEqual([]);
    expect(result.current.projectStatusesByProject[PROJECT_ID]).toMatchObject({
      state: "empty",
    });
  });
});

describe("useProjectQueues backstop", () => {
  const NOW_MS = Date.parse("2026-08-05T00:00:00.000Z");

  function statusWith(
    state: ProjectQueueProjectStatus["state"],
    overrides: Partial<ProjectQueueProjectStatus> = {},
  ): ProjectQueueProjectStatus {
    return { ...makeProjectStatus(state), ...overrides };
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
    vi.setSystemTime(NOW_MS);
    resetProjectQueueBackstopsForTests();
  });

  afterEach(() => {
    resetProjectQueueBackstopsForTests();
    vi.useRealTimers();
  });

  it("arms one backstop for the whole source, not one per consumer", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("dispatching") },
    });

    renderHook(() => useProjectQueues(["project-1"]));
    renderHook(() => useProjectQueues(["project-1"]));
    renderHook(() => useProjectQueues(["project-1"]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    // Three mounted consumers used to mean three five-second intervals.
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
  });

  it("waits out a reported quiet window instead of sampling through it", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: {
        [PROJECT_ID]: statusWith("waiting-quiet", {
          quietEligibleAt: new Date(NOW_MS + 30_000).toISOString(),
        }),
      },
    });

    renderHook(() => useProjectQueues(["project-1"]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    // The old interval would have read six times before the window elapsed.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
  });

  it("arms no timer for a blocked backlog that only events can release", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("blocked") },
    });

    renderHook(() => useProjectQueues(["project-1"]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);
  });

  it("releases the backstop when the last consumer unmounts", async () => {
    apiMock.getProjectQueueItems.mockResolvedValue({
      items: [makeItem("1", PROJECT_ID)],
      projectStatuses: { [PROJECT_ID]: statusWith("dispatching") },
    });

    const first = renderHook(() => useProjectQueues(["project-1"]));
    const second = renderHook(() => useProjectQueues(["project-1"]));
    await settle();
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(1);

    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    // One consumer left, so the backstop is still owned.
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);

    second.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(apiMock.getProjectQueueItems).toHaveBeenCalledTimes(2);
  });
});
