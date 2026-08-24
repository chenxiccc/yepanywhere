import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../../types";

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    getProject: vi.fn(),
    getProjects: vi.fn(),
    isRemoteClient: vi.fn(() => false),
    remoteState: {
      connection: null as { connection: object | null } | null,
    },
    activityBus: {
      on: vi.fn((event: string, handler: (data: unknown) => void) => {
        let set = handlers.get(event);
        if (!set) {
          set = new Set();
          handlers.set(event, set);
        }
        set.add(handler);
        return () => handlers.get(event)?.delete(handler);
      }),
      emit(event: string, data?: unknown) {
        for (const handler of handlers.get(event) ?? []) {
          handler(data);
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
    getProject: mocks.getProject,
    getProjects: mocks.getProjects,
  },
}));

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: mocks.activityBus.on,
    onSource: (
      _sourceKey: string,
      event: string,
      handler: (data: unknown) => void,
    ) => mocks.activityBus.on(event, handler),
    retainSourceStream: vi.fn(() => () => {}),
  },
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: mocks.isRemoteClient,
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => mocks.remoteState.connection,
}));

import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import { resetClientSummaryStoreForTests } from "../../lib/clientSummaryStore";
import { useProject, useProjects } from "../useProjects";

const RECENT = "2026-06-27T11:00:00.000Z";

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    path: `/tmp/${id}`,
    name: `Project ${id}`,
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    projectQueueBlockingCount: 0,
    lastActivity: RECENT,
    ...overrides,
  };
}

beforeEach(() => {
  resetClientSummaryStoreForTests();
  resetClientQueryControllerForTests();
  mocks.getProject.mockReset();
  mocks.getProjects.mockReset();
  mocks.isRemoteClient.mockReset();
  mocks.isRemoteClient.mockReturnValue(false);
  mocks.remoteState.connection = null;
  mocks.activityBus.reset();
  mocks.activityBus.on.mockClear();
});

afterEach(() => {
  cleanup();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  vi.useRealTimers();
});

describe("useProjects", () => {
  it("feeds project list responses into the collection store", async () => {
    mocks.getProjects.mockResolvedValue({
      projects: [project("project-a"), project("project-b")],
    });

    const { result } = renderHook(() => useProjects());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeNull();
    expect(result.current.projects.map((row) => row.id)).toEqual([
      "project-a",
      "project-b",
    ]);
    expect(mocks.getProjects).toHaveBeenCalledTimes(1);
  });

  it("coalesces project list refresh events through the retained query", async () => {
    vi.useFakeTimers();
    mocks.getProjects
      .mockResolvedValueOnce({
        projects: [project("project-a")],
      })
      .mockResolvedValueOnce({
        projects: [project("project-a"), project("project-b")],
      });

    const { result } = renderHook(() => useProjects());
    await settle();
    expect(result.current.loading).toBe(false);
    expect(mocks.getProjects).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.activityBus.emit("refresh");
      mocks.activityBus.emit("reconnect");
      mocks.activityBus.emit("project-code-names-changed", {
        type: "project-code-names-changed",
        projectIds: ["project-a"],
        timestamp: RECENT,
      });
      await vi.advanceTimersByTimeAsync(499);
    });
    expect(mocks.getProjects).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.getProjects).toHaveBeenCalledTimes(2);
    expect(result.current.projects.map((row) => row.id)).toEqual([
      "project-a",
      "project-b",
    ]);
  });

  it("shares collection-backed project facts between list and detail hooks", async () => {
    mocks.getProjects.mockResolvedValue({
      projects: [project("project-a", { name: "List Project" })],
    });
    mocks.getProject.mockResolvedValue({
      project: project("project-a", {
        name: "Detail Project",
        sessionCount: 2,
      }),
    });

    const list = renderHook(() => useProjects());
    await waitFor(() => expect(list.result.current.loading).toBe(false));
    expect(list.result.current.projects[0]?.name).toBe("List Project");

    const detail = renderHook(() => useProject("project-a"));
    await waitFor(() => expect(detail.result.current.loading).toBe(false));

    expect(detail.result.current.project).toMatchObject({
      id: "project-a",
      name: "Detail Project",
      sessionCount: 2,
    });
    await waitFor(() =>
      expect(list.result.current.projects[0]?.name).toBe("Detail Project"),
    );
  });

  it("revalidates project detail for matching activity and code-name changes", async () => {
    vi.useFakeTimers();
    mocks.getProject
      .mockResolvedValueOnce({
        project: project("project-a", { activeOwnedCount: 1 }),
      })
      .mockResolvedValueOnce({
        project: project("project-a", { activeOwnedCount: 2 }),
      })
      .mockResolvedValueOnce({
        project: project("project-a", {
          activeOwnedCount: 2,
          codeName: "alp",
        }),
      });

    const detail = renderHook(() => useProject("project-a"));
    await settle();
    expect(detail.result.current.loading).toBe(false);
    expect(mocks.getProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.activityBus.emit("process-state-changed", {
        type: "process-state-changed",
        sessionId: "session-b",
        projectId: "project-b",
        activity: "in-turn",
        timestamp: "2026-06-29T00:00:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.getProject).toHaveBeenCalledTimes(1);

    await act(async () => {
      mocks.activityBus.emit("process-state-changed", {
        type: "process-state-changed",
        sessionId: "session-a",
        projectId: "project-a",
        activity: "in-turn",
        timestamp: "2026-06-29T00:00:01.000Z",
      });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mocks.getProject).toHaveBeenCalledTimes(2);
    expect(detail.result.current.project?.activeOwnedCount).toBe(2);

    await act(async () => {
      mocks.activityBus.emit("project-code-names-changed", {
        type: "project-code-names-changed",
        projectIds: ["project-a"],
        timestamp: "2026-06-29T00:00:02.000Z",
      });
      await vi.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.getProject).toHaveBeenCalledTimes(3);
  });
});
