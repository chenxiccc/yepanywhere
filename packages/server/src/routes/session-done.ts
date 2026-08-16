import type { DurableSyntheticDoneMessage } from "@yep-anywhere/shared";
import { randomUUID } from "node:crypto";
import { Hono } from "hono";
import type { SessionMetadataService } from "../metadata/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { Supervisor } from "../supervisor/Supervisor.js";

export interface SessionDoneRoutesDeps {
  sessionMetadataService?: SessionMetadataService;
  notificationService?: NotificationService;
  supervisor: Supervisor;
}

export function createSessionDoneRoutes(deps: SessionDoneRoutesDeps): Hono {
  const routes = new Hono();

  routes.post("/:sessionId/done", async (c) => {
    const { sessionMetadataService } = deps;
    if (!sessionMetadataService) {
      return c.json({ error: "Session metadata service unavailable" }, 503);
    }

    const sessionId = c.req.param("sessionId");
    const timestamp = new Date().toISOString();
    const uuid = `ya-done-${randomUUID()}`;
    const message: DurableSyntheticDoneMessage = {
      type: "user",
      content: "/done",
      message: { role: "user", content: "/done" },
      timestamp,
      uuid,
      id: uuid,
      isSynthetic: true,
      yaSyntheticSource: "done",
    };

    await sessionMetadataService.recordSyntheticDone(sessionId, message);
    await deps.supervisor.pauseSessionAutomation(sessionId);
    await deps.notificationService?.markSeen(sessionId, timestamp, uuid);

    return c.json({ message, paused: true });
  });

  return routes;
}
