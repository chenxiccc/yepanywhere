import { type Context, Hono } from "hono";
import {
  BROWSER_DEBUG_MAX_EVAL_BYTES,
  BrowserDebugError,
  type BrowserDebugEventInput,
  type BrowserDebugEvalResult,
  type BrowserDebugService,
} from "../services/BrowserDebugService.js";
import {
  LimitedJsonBodyError,
  readLimitedJsonObject,
} from "./limited-json-body.js";

const MAX_EVENT_BATCH = 100;
const MAX_EVENT_KIND_CHARS = 80;
const MAX_EVENT_BATCH_BYTES = 256 * 1024;
const MAX_LEASE_BODY_BYTES = 4 * 1024;
const MAX_RESULT_BODY_BYTES = 256 * 1024;

function bearerToken(value: string | undefined): string {
  const match = value?.match(/^Bearer\s+(.+)$/iu);
  return match?.[1]?.trim() ?? "";
}

async function jsonObject(
  c: Context,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  try {
    return await readLimitedJsonObject(c.req.raw, maxBytes);
  } catch (error) {
    if (
      error instanceof LimitedJsonBodyError &&
      error.failure === "too-large"
    ) {
      throw new BrowserDebugError(
        413,
        "Browser diagnostic request is too large",
      );
    }
    if (
      error instanceof LimitedJsonBodyError &&
      error.failure === "expected-object"
    ) {
      throw new BrowserDebugError(400, "Expected a JSON object");
    }
    throw new BrowserDebugError(400, "Expected a JSON request body");
  }
}

function errorResponse(c: Context, error: unknown) {
  if (error instanceof BrowserDebugError) {
    return c.json({ error: error.message }, error.status);
  }
  throw error;
}

function controllerToken(c: Context): string {
  return c.req.header("X-YA-Browser-Debug-Controller")?.trim() ?? "";
}

function grantSecret(c: Context): string {
  return c.req.header("X-YA-Browser-Debug-Grant")?.trim() ?? "";
}

export function createBrowserDebugClientRoutes(
  service: BrowserDebugService,
): Hono {
  const routes = new Hono();

  routes.post("/leases", async (c) => {
    try {
      const body = await jsonObject(c, MAX_LEASE_BODY_BYTES);
      if (
        typeof body.sessionId !== "string" ||
        typeof body.tabId !== "string"
      ) {
        throw new BrowserDebugError(400, "sessionId and tabId are required");
      }
      return c.json(
        { lease: service.createLease(body.sessionId, body.tabId) },
        201,
      );
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/leases/:leaseId/poll", async (c) => {
    try {
      const command = await service.poll(
        c.req.param("leaseId"),
        controllerToken(c),
        undefined,
        c.req.raw.signal,
      );
      return c.json({ command });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/leases/:leaseId/results", async (c) => {
    try {
      const body = await jsonObject(c, MAX_RESULT_BODY_BYTES);
      if (typeof body.commandId !== "string") {
        throw new BrowserDebugError(400, "commandId is required");
      }
      if (!body.result || typeof body.result !== "object") {
        throw new BrowserDebugError(400, "result is required");
      }
      const result = body.result as Record<string, unknown>;
      if (typeof result.ok !== "boolean") {
        throw new BrowserDebugError(400, "result.ok must be boolean");
      }
      service.submitResult(
        c.req.param("leaseId"),
        controllerToken(c),
        body.commandId,
        result as unknown as BrowserDebugEvalResult,
      );
      return c.json({ accepted: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/leases/:leaseId/events", async (c) => {
    try {
      const body = await jsonObject(c, MAX_EVENT_BATCH_BYTES);
      if (!Array.isArray(body.events) || body.events.length > MAX_EVENT_BATCH) {
        throw new BrowserDebugError(
          400,
          "events must be an array of at most 100 items",
        );
      }
      const events: BrowserDebugEventInput[] = body.events.map((value) => {
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          throw new BrowserDebugError(400, "Each event must be an object");
        }
        const event = value as Record<string, unknown>;
        if (
          typeof event.timestamp !== "number" ||
          !Number.isFinite(event.timestamp) ||
          typeof event.kind !== "string" ||
          !event.kind ||
          event.kind.length > MAX_EVENT_KIND_CHARS
        ) {
          throw new BrowserDebugError(
            400,
            "Each event needs a timestamp and short kind",
          );
        }
        return {
          timestamp: event.timestamp,
          kind: event.kind,
          ...(event.data === undefined ? {} : { data: event.data }),
        };
      });
      service.appendEvents(c.req.param("leaseId"), controllerToken(c), events);
      return c.json({ accepted: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.delete("/leases/:leaseId", (c) => {
    try {
      service.revoke(c.req.param("leaseId"), controllerToken(c));
      return c.json({ revoked: true });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}

export function createBrowserDebugAgentRoutes(
  service: BrowserDebugService,
): Hono {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    try {
      service.authorizeCaller(bearerToken(c.req.header("Authorization")));
      await next();
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/leases/:leaseId", (c) => {
    try {
      return c.json({
        lease: service.getLeaseInfo(c.req.param("leaseId"), grantSecret(c)),
      });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.get("/leases/:leaseId/events", (c) => {
    try {
      const rawAfter = c.req.query("after") ?? "0";
      if (!/^\d+$/u.test(rawAfter)) {
        throw new BrowserDebugError(
          400,
          "after must be a non-negative event sequence",
        );
      }
      const after = Number.parseInt(rawAfter, 10);
      if (!Number.isSafeInteger(after)) {
        throw new BrowserDebugError(
          400,
          "after must be a non-negative event sequence",
        );
      }
      const events = service.readEvents(
        c.req.param("leaseId"),
        grantSecret(c),
        after,
      );
      return c.json({ events });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  routes.post("/leases/:leaseId/eval", async (c) => {
    try {
      const body = await jsonObject(
        c,
        BROWSER_DEBUG_MAX_EVAL_BYTES + MAX_LEASE_BODY_BYTES,
      );
      if (
        typeof body.code !== "string" ||
        !body.code ||
        Buffer.byteLength(body.code, "utf8") > BROWSER_DEBUG_MAX_EVAL_BYTES
      ) {
        throw new BrowserDebugError(
          413,
          "code is required and must fit the size limit",
        );
      }
      const result = await service.evaluate(
        c.req.param("leaseId"),
        grantSecret(c),
        body.code,
      );
      return c.json({ result });
    } catch (error) {
      return errorResponse(c, error);
    }
  });

  return routes;
}
