import { Hono } from "hono";
import {
  SESSION_WAKE_TEXT_MAX_CHARS,
  type SessionWakeService,
} from "../services/SessionWakeService.js";

const OPTIONAL_FIELD_MAX_CHARS = 200;

export function createSessionWakeRoutes(service: SessionWakeService): Hono {
  const routes = new Hono();
  routes.post("/:sessionId", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Expected a JSON request body" }, 400);
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ error: "Expected a JSON object" }, 400);
    }
    const { text, source, jobId } = body as Record<string, unknown>;
    if (typeof text !== "string" || !text.trim()) {
      return c.json({ error: "text must be a non-empty string" }, 400);
    }
    if (text.length > SESSION_WAKE_TEXT_MAX_CHARS) {
      return c.json(
        { error: `text exceeds ${SESSION_WAKE_TEXT_MAX_CHARS} characters` },
        413,
      );
    }
    if (
      (source !== undefined &&
        (typeof source !== "string" ||
          source.length > OPTIONAL_FIELD_MAX_CHARS)) ||
      (jobId !== undefined &&
        (typeof jobId !== "string" || jobId.length > OPTIONAL_FIELD_MAX_CHARS))
    ) {
      return c.json({ error: "source and jobId must be short strings" }, 400);
    }

    const result = await service.accept(
      c.req.param("sessionId"),
      c.req.header("Authorization"),
      {
        text,
        ...(source === undefined ? {} : { source }),
        ...(jobId === undefined ? {} : { jobId }),
      },
    );
    if (result.status === 202) return c.json({ accepted: true }, 202);
    return c.json({ error: result.error }, result.status);
  });
  return routes;
}
