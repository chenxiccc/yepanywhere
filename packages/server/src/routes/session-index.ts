import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";

export interface SessionIndexRoutesDeps {
  sessionIndexService: Pick<SessionIndexService, "getWarmupStatus">;
}

export function createSessionIndexRoutes(deps: SessionIndexRoutesDeps): Hono {
  const routes = new Hono();

  routes.get("/status", (c) => {
    return c.json(deps.sessionIndexService.getWarmupStatus());
  });

  return routes;
}
