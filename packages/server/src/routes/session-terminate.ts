import { Hono } from "hono";
import type { SessionMetadataService } from "../metadata/index.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { EventBus } from "../watcher/EventBus.js";
import { sessionQueueSummaries } from "./session-queue-summaries.js";

export interface SessionTerminateRoutesDeps {
  sessionMetadataService?: SessionMetadataService;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  supervisor: Supervisor;
  eventBus?: EventBus;
}

export function createSessionTerminateRoutes(
  deps: SessionTerminateRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.post("/:sessionId/terminate", async (c) => {
    if (!deps.sessionMetadataService) {
      return c.json({ error: "Session metadata service unavailable" }, 503);
    }

    const sessionId = c.req.param("sessionId");
    const result = await deps.supervisor.requestSessionBoundaryAndAbort(
      sessionId,
      "/terminate",
    );
    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      archived: true,
      timestamp: new Date().toISOString(),
    });
    return c.json({
      ...result,
      deferredMessages: sessionQueueSummaries(deps, sessionId, undefined),
    });
  });

  return routes;
}
