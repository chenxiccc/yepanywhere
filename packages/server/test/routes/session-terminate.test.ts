import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import { createSessionTerminateRoutes } from "../../src/routes/session-terminate.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { EventBus } from "../../src/watcher/EventBus.js";

describe("session terminate route", () => {
  it("archives, blocks resume, and terminates through /terminate", async () => {
    const requestSessionBoundaryAndAbort = vi.fn(async () => ({
      paused: true as const,
      queued: false,
      termination: null,
      resumeExemption: {
        heartbeatDisabled: true,
        autoResumeDisabled: true,
      },
      message: {
        type: "user" as const,
        content: "/terminate" as const,
        message: { role: "user" as const, content: "/terminate" as const },
        timestamp: "2026-08-22T10:00:00.000Z",
        uuid: "ya-done-terminate",
        id: "ya-done-terminate",
        isSynthetic: true as const,
        yaSyntheticSource: "done" as const,
      },
    }));
    const emit = vi.fn();
    const app = new Hono();
    app.route(
      "/api/sessions",
      createSessionTerminateRoutes({
        sessionMetadataService: {
          getMetadata: () => undefined,
        } as unknown as SessionMetadataService,
        supervisor: {
          requestSessionBoundaryAndAbort,
        } as unknown as Supervisor,
        eventBus: { emit } as unknown as EventBus,
      }),
    );

    const response = await app.request("/api/sessions/session-1/terminate", {
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      queued: false,
      message: { content: "/terminate" },
      resumeExemption: { autoResumeDisabled: true },
    });
    expect(requestSessionBoundaryAndAbort).toHaveBeenCalledWith(
      "session-1",
      "/terminate",
    );
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "session-1",
        archived: true,
      }),
    );
  });

  it("fails closed when durable session metadata is unavailable", async () => {
    const requestSessionBoundaryAndAbort = vi.fn();
    const app = new Hono();
    app.route(
      "/api/sessions",
      createSessionTerminateRoutes({
        supervisor: {
          requestSessionBoundaryAndAbort,
        } as unknown as Supervisor,
      }),
    );

    const response = await app.request("/api/sessions/session-1/terminate", {
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(requestSessionBoundaryAndAbort).not.toHaveBeenCalled();
  });
});
