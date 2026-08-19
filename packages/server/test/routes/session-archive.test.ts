import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import { createSessionArchiveRoutes } from "../../src/routes/session-archive.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";
import type { EventBus } from "../../src/watcher/EventBus.js";

describe("session archive route", () => {
  it("archives through the done coordinator and preserves /archive projections", async () => {
    const requestSessionDone = vi.fn(async () => ({
      paused: true as const,
      queued: true,
      message: {
        type: "user" as const,
        content: "/archive" as const,
        message: { role: "user" as const, content: "/archive" as const },
        timestamp: "2026-08-17T10:00:00.000Z",
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
          content: "/archive",
          timestamp: "2026-08-17T10:00:00.000Z",
          kind: "ya-command" as const,
          yaCommand: "done" as const,
          status: "queued" as const,
        },
      ],
    }));
    const emit = vi.fn();
    const app = new Hono();
    app.route(
      "/api/sessions",
      createSessionArchiveRoutes({
        sessionMetadataService: {
          getMetadata: () => undefined,
        } as unknown as SessionMetadataService,
        supervisor: {
          requestSessionDone,
          getProcessForSession,
        } as unknown as Supervisor,
        eventBus: { emit } as unknown as EventBus,
      }),
    );

    const response = await app.request("/api/sessions/session-1/archive", {
      method: "POST",
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      paused: true,
      queued: true,
      message: {
        content: "/archive",
        message: { role: "user", content: "/archive" },
      },
      deferredMessages: [
        {
          content: "/archive",
          kind: "ya-command",
          yaCommand: "done",
        },
      ],
    });
    expect(requestSessionDone).toHaveBeenCalledWith("session-1", "/archive");
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session-metadata-changed",
        sessionId: "session-1",
        archived: true,
      }),
    );
  });

  it("fails closed when durable session metadata is unavailable", async () => {
    const requestSessionDone = vi.fn(async () => {
      throw new Error("should not run");
    });
    const app = new Hono();
    app.route(
      "/api/sessions",
      createSessionArchiveRoutes({
        supervisor: { requestSessionDone } as unknown as Supervisor,
      }),
    );

    const response = await app.request("/api/sessions/session-1/archive", {
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(requestSessionDone).not.toHaveBeenCalled();
  });
});
