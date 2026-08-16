import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import type { Process } from "../../src/supervisor/Process.js";
import { SessionDoneCoordinator } from "../../src/supervisor/SessionDoneCoordinator.js";

function coordinatorProcess(overrides: Partial<Process> = {}): Process {
  const pending: Array<{ tempId: string; timestamp: string }> = [];
  return {
    sessionId: "session-1",
    id: "process-1",
    projectId: "project-1",
    state: { type: "in-turn" },
    userTurnVersion: 1,
    isRetainingProviderWork: () => false,
    hasPendingYaCommand: () => pending.length > 0,
    getPendingYaCommand: () =>
      pending[0]
        ? {
            command: "done",
            tempId: pending[0].tempId,
            timestamp: pending[0].timestamp,
            userTurnVersion: 1,
            completionStarted: false,
          }
        : undefined,
    queueYaCommand: () => {
      const entry = {
        tempId: "ya-done-queued",
        timestamp: "2026-08-16T10:00:00.000Z",
      };
      pending.push(entry);
      return {
        command: "done",
        ...entry,
        userTurnVersion: 1,
        completionStarted: false,
      };
    },
    pauseRecapsUntilUserTurn: vi.fn(),
    handleAutomationPauseChanged: vi.fn(),
    ...overrides,
  } as unknown as Process;
}

describe("SessionDoneCoordinator", () => {
  it("persists the automation pause before queuing a live-turn /done", async () => {
    const order: string[] = [];
    const process = coordinatorProcess();
    const updateMetadata = vi.fn(async () => {
      order.push("persist");
    });
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        updateMetadata,
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {
        order.push("cancel-recap");
      },
      requestHeartbeatSweep: () => {
        order.push("sweep");
      },
    });

    const originalQueue = process.queueYaCommand.bind(process);
    process.queueYaCommand = ((...args) => {
      order.push("queue");
      return originalQueue(...args);
    }) as Process["queueYaCommand"];

    const result = await state.requestSessionDone("session-1");

    expect(result).toMatchObject({ queued: true, paused: true });
    expect(updateMetadata).toHaveBeenCalledWith("session-1", {
      automationPausedUntilUserTurn: true,
    });
    expect(order[0]).toBe("persist");
    expect(order).toContain("queue");
    expect(process.hasPendingYaCommand("done")).toBe(true);
  });

  it("does not queue /done when the pause cannot be persisted", async () => {
    const process = coordinatorProcess();
    const queueYaCommand = vi.fn(process.queueYaCommand);
    process.queueYaCommand = queueYaCommand;
    const state = new SessionDoneCoordinator({
      sessionMetadataService: {
        getMetadata: () => undefined,
        updateMetadata: async () => {
          throw new Error("disk full");
        },
      } as unknown as SessionMetadataService,
      getProcessForSession: () => process,
      cancelInFlightForkedRecap: () => {},
      requestHeartbeatSweep: () => {},
    });

    await expect(state.requestSessionDone("session-1")).rejects.toThrow(
      "disk full",
    );
    expect(queueYaCommand).not.toHaveBeenCalled();
    expect(process.hasPendingYaCommand("done")).toBe(false);
  });
});
