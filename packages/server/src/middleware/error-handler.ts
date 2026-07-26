import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * An error that names its own HTTP response status. Throw it from a service
 * when the failure maps to a specific status (e.g. 503 while a service is not
 * yet initialized). Foreign statusCode-bearing errors (e.g. web-push upstream
 * failures) are reported in the body but do not drive the response status.
 */
export class HttpError extends Error {
  readonly status: ContentfulStatusCode;

  constructor(status: ContentfulStatusCode, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

/**
 * App-wide Hono error handler: an unhandled throw in any route returns
 * structured JSON `{ error, statusCode? }` instead of an opaque empty 500
 * the client cannot diagnose (kzahel/yepanywhere#84). Hono routes a sub-app's
 * thrown errors to the mounted app's handler, so installing this on the root
 * app covers every route group; a sub-app exercised by direct-request tests
 * installs the same handler itself.
 */
export function structuredErrorHandler(error: Error, c: Context): Response {
  if (error instanceof HTTPException) {
    return error.getResponse();
  }
  const message = error.message || String(error);
  console.error(`[API] ${c.req.method} ${c.req.path} error:`, message);
  if (error instanceof HttpError) {
    return c.json({ error: message }, error.status);
  }
  const rawStatus = (error as { statusCode?: unknown }).statusCode;
  const statusCode = typeof rawStatus === "number" ? rawStatus : undefined;
  return c.json(
    { error: message, ...(statusCode !== undefined ? { statusCode } : {}) },
    500,
  );
}
