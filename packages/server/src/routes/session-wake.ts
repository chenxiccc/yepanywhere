import { Hono } from "hono";
import {
  SESSION_WAKE_TEXT_MAX_CHARS,
  type SessionWakeService,
} from "../services/SessionWakeService.js";
import {
  LimitedJsonBodyError,
  readLimitedJsonObject,
} from "./limited-json-body.js";

const OPTIONAL_FIELD_MAX_CHARS = 200;
const SESSION_WAKE_BODY_MAX_BYTES = 8 * 1024;

export function createSessionWakeRoutes(service: SessionWakeService): Hono {
  const routes = new Hono();
  routes.post("/:sessionId", async (c) => {
    const sessionId = c.req.param("sessionId");
    const authorization = c.req.header("Authorization");
    if (!service.isAuthorized(sessionId, authorization)) {
      return c.json({ error: "Invalid session wake credentials" }, 401);
    }

    let body: Record<string, unknown>;
    try {
      body = await readLimitedJsonObject(
        c.req.raw,
        SESSION_WAKE_BODY_MAX_BYTES,
      );
    } catch (error) {
      if (
        error instanceof LimitedJsonBodyError &&
        error.failure === "too-large"
      ) {
        return c.json({ error: "Session wake request is too large" }, 413);
      }
      if (
        error instanceof LimitedJsonBodyError &&
        error.failure === "expected-object"
      ) {
        return c.json({ error: "Expected a JSON object" }, 400);
      }
      return c.json({ error: "Expected a JSON request body" }, 400);
    }
    const { text, source, jobId } = body;
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

    const result = await service.accept(sessionId, authorization, {
      text,
      ...(source === undefined ? {} : { source }),
      ...(jobId === undefined ? {} : { jobId }),
    });
    if (result.status === 202) return c.json({ accepted: true }, 202);
    return c.json({ error: result.error }, result.status);
  });
  return routes;
}
