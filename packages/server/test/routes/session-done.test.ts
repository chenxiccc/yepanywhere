import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import { createSessionDoneRoutes } from "../../src/routes/session-done.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";

describe("session done route", () => {
  it("returns the supervisor result and canonical queued-message projection", async () => {
    const requestSessionBoundaryAndAbort = vi.fn(async () => ({
      paused: true as const,
      queued: true,
      message: {
        type: "user" as const,
        content: "/done" as const,
        message: { role: "user" as const, content: "/done" as const },
        timestamp: "2026-08-16T10:00:00.000Z",
        uuid: "ya-done-1",
        id: "ya-done-1",
        isSynthetic: true as const,
        yaSyntheticSource: "done" as const,
      },
    }));
    const getProcessForSession = vi.fn(() => ({
      getDeferredQueueSummary: () => [
        {
          tempId: "ya-done-1",
          content: "/done",
          timestamp: "2026-08-16T10:00:00.000Z",
          kind: "ya-command" as const,
          yaCommand: "done" as const,
          status: "queued" as const,
        },
      ],
    }));
    const app = new Hono();
    app.route(
      "/api/sessions",
      createSessionDoneRoutes({
        sessionMetadataService: {
          getMetadata: () => undefined,
        } as unknown as SessionMetadataService,
        supervisor: {
          requestSessionBoundaryAndAbort,
          getProcessForSession,
        } as unknown as Supervisor,
      }),
    );

    const response = await app.request("/api/sessions/session-1/done", {
      method: "POST",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      paused: true,
      queued: true,
      message: {
        type: "user",
        content: "/done",
        message: { role: "user", content: "/done" },
        isSynthetic: true,
        yaSyntheticSource: "done",
      },
      deferredMessages: [
        {
          content: "/done",
          kind: "ya-command",
          yaCommand: "done",
        },
      ],
    });
    expect(requestSessionBoundaryAndAbort).toHaveBeenCalledWith("session-1");
    expect(getProcessForSession).toHaveBeenCalledWith("session-1");
  });

  it("fails closed when durable session metadata is unavailable", async () => {
    const requestSessionBoundaryAndAbort = vi.fn(async () => {
      throw new Error("should not run");
    });
    const app = new Hono();
    app.route(
      "/api/sessions",
      createSessionDoneRoutes({
        supervisor: {
          requestSessionBoundaryAndAbort,
        } as unknown as Supervisor,
      }),
    );

    const response = await app.request("/api/sessions/session-1/done", {
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(requestSessionBoundaryAndAbort).not.toHaveBeenCalled();
  });
});
