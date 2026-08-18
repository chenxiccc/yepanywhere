import { Hono } from "hono";
import type { SessionMetadataService } from "../metadata/index.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { EventBus } from "../watcher/EventBus.js";
import { sessionQueueSummaries } from "./session-queue-summaries.js";

export interface SessionArchiveRoutesDeps {
  sessionMetadataService?: SessionMetadataService;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
  supervisor: Supervisor;
  eventBus?: EventBus;
}

export function createSessionArchiveRoutes(
  deps: SessionArchiveRoutesDeps,
): Hono {
  const routes = new Hono();

  routes.post("/:sessionId/archive", async (c) => {
    const { sessionMetadataService } = deps;
    if (!sessionMetadataService) {
      return c.json({ error: "Session metadata service unavailable" }, 503);
    }

    const sessionId = c.req.param("sessionId");
    const result = await deps.supervisor.requestSessionDone(
      sessionId,
      "/archive",
    );
    deps.eventBus?.emit({
      type: "session-metadata-changed",
      sessionId,
      archived: true,
      timestamp: new Date().toISOString(),
    });
    const process = deps.supervisor.getProcessForSession(sessionId);
    return c.json({
      ...result,
      deferredMessages: sessionQueueSummaries(deps, sessionId, process),
    });
  });

  return routes;
}
