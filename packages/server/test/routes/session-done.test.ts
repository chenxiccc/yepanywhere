import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import type { NotificationService } from "../../src/notifications/index.js";
import { createSessionDoneRoutes } from "../../src/routes/session-done.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";

describe("session done route", () => {
  it("records a YA-only row, pauses automation, and marks the session read", async () => {
    const recordSyntheticDone = vi.fn(async () => {});
    const pauseSessionAutomation = vi.fn(async () => {});
    const markSeen = vi.fn(async () => {});
    const app = new Hono();
    app.route(
      "/api/sessions",
      createSessionDoneRoutes({
        sessionMetadataService: {
          recordSyntheticDone,
        } as unknown as SessionMetadataService,
        notificationService: { markSeen } as unknown as NotificationService,
        supervisor: {
          pauseSessionAutomation,
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
      message: {
        type: "user",
        content: "/done",
        message: { role: "user", content: "/done" },
        isSynthetic: true,
        yaSyntheticSource: "done",
      },
    });
    expect(recordSyntheticDone).toHaveBeenCalledWith("session-1", body.message);
    expect(pauseSessionAutomation).toHaveBeenCalledWith("session-1");
    expect(markSeen).toHaveBeenCalledWith(
      "session-1",
      body.message.timestamp,
      body.message.uuid,
    );
  });

  it("fails closed when durable session metadata is unavailable", async () => {
    const pauseSessionAutomation = vi.fn(async () => {});
    const app = new Hono();
    app.route(
      "/api/sessions",
      createSessionDoneRoutes({
        supervisor: { pauseSessionAutomation } as unknown as Supervisor,
      }),
    );

    const response = await app.request("/api/sessions/session-1/done", {
      method: "POST",
    });

    expect(response.status).toBe(503);
    expect(pauseSessionAutomation).not.toHaveBeenCalled();
  });
});
