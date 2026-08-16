import { Hono } from "hono";
import type { SessionMetadataService } from "../metadata/index.js";
import type { SessionQueuePersistenceService } from "../services/SessionQueuePersistenceService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import { sessionQueueSummaries } from "./session-queue-summaries.js";

export interface SessionDoneRoutesDeps {
  sessionMetadataService?: SessionMetadataService;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
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
    const result = await deps.supervisor.requestSessionDone(sessionId);
    const process = deps.supervisor.getProcessForSession(sessionId);
    return c.json({
      ...result,
      deferredMessages: sessionQueueSummaries(deps, sessionId, process),
    });
  });

  return routes;
}
