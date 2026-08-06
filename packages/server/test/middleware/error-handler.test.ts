import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { structuredErrorHandler } from "../../src/middleware/error-handler.js";

describe("structuredErrorHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("redacts public-share bearer segments from error logs", async () => {
    const secret = "bearer-secret-that-must-not-be-logged";
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const app = new Hono();
    app.get("/public-api/shares/:secret/session", () => {
      throw new Error("failed");
    });
    app.onError(structuredErrorHandler);

    const response = await app.request(`/public-api/shares/${secret}/session`);
    const logged = log.mock.calls.flat().join(" ");

    expect(response.status).toBe(500);
    expect(logged).toContain("/public-api/shares/[redacted]/session");
    expect(logged).not.toContain(secret);
  });
});
