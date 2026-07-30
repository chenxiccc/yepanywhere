import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthService } from "../../src/auth/AuthService.js";
import { createAuthRoutes } from "../../src/auth/routes.js";
import {
  DESKTOP_SESSION_COOKIE_NAME,
  DesktopBootstrapService,
} from "../../src/desktop/DesktopBootstrapService.js";
import { createAuthMiddleware } from "../../src/middleware/auth.js";

describe("desktop session authentication floor", () => {
  let testDir: string;
  let authService: AuthService;
  let bootstrapService: DesktopBootstrapService;
  let app: Hono;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "desktop-auth-test-"));
    authService = new AuthService({
      dataDir: testDir,
      cookieSecret: "test-cookie-secret",
    });
    await authService.initialize();
    bootstrapService = new DesktopBootstrapService({
      masterSecret: "s".repeat(64),
    });
    app = new Hono();
    app.use(
      "/api/*",
      createAuthMiddleware({
        authService,
        desktopBootstrapService: bootstrapService,
      }),
    );
    app.route(
      "/api/auth",
      createAuthRoutes({
        authService,
        desktopBootstrapService: bootstrapService,
      }),
    );
    app.get("/api/protected", (c) => c.json({ ok: true }));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function desktopCookie(): string {
    const session = bootstrapService.consumeCode(
      bootstrapService.mintCode().code,
    );
    if (!session) throw new Error("failed to create test desktop session");
    return `${DESKTOP_SESSION_COOKIE_NAME}=${session}`;
  }

  it("requires the desktop cookie even when password auth is disabled", async () => {
    const status = await app.request("/api/auth/status");
    const protectedResponse = await app.request("/api/protected");

    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(
      expect.objectContaining({
        enabled: false,
        authenticated: false,
        hasDesktopToken: true,
      }),
    );
    expect(protectedResponse.status).toBe(401);

    const cookie = desktopCookie();
    const authenticated = await app.request("/api/protected", {
      headers: { Cookie: cookie },
    });
    expect(authenticated.status).toBe(200);
  });

  it("accepts a loopback-established desktop session alongside password auth", async () => {
    await authService.enableAuth("password123");
    const status = await app.request("/api/auth/status", {
      headers: { Cookie: desktopCookie() },
    });

    expect(status.status).toBe(200);
    expect(await status.json()).toEqual(
      expect.objectContaining({
        enabled: true,
        authenticated: true,
        setupRequired: false,
      }),
    );
  });
});
