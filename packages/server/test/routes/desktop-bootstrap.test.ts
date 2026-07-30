import type { HttpBindings } from "@hono/node-server";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_SESSION_COOKIE_NAME,
  DesktopBootstrapService,
} from "../../src/desktop/DesktopBootstrapService.js";
import { createDesktopBootstrapRoutes } from "../../src/routes/desktop-bootstrap.js";

const MASTER_SECRET = "s".repeat(64);

function socketBindings(
  remoteAddress = "127.0.0.1",
  localAddress = "127.0.0.1",
): HttpBindings {
  return {
    incoming: {
      socket: { remoteAddress, localAddress },
    },
  } as unknown as HttpBindings;
}

describe("desktop bootstrap routes", () => {
  it("mints on loopback and exchanges a code for a host-only cookie once", async () => {
    const service = new DesktopBootstrapService({
      masterSecret: MASTER_SECRET,
    });
    const routes = createDesktopBootstrapRoutes(service);
    const bindings = socketBindings();

    const mint = await routes.request(
      "http://127.0.0.1/mint",
      {
        method: "POST",
        headers: {
          "x-yep-desktop-bootstrap-secret": MASTER_SECRET,
        },
      },
      bindings,
    );
    const { code } = (await mint.json()) as { code: string };
    const exchange = await routes.request(
      `http://127.0.0.1/${code}`,
      undefined,
      bindings,
    );

    expect(mint.status).toBe(200);
    expect(exchange.status).toBe(303);
    expect(exchange.headers.get("location")).toBe("/");
    expect(exchange.headers.get("cache-control")).toBe("no-store");
    const cookie = exchange.headers.get("set-cookie") ?? "";
    expect(cookie).toContain(`${DESKTOP_SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).not.toContain("Domain=");
    expect(cookie).not.toContain("Secure");

    const session = cookie
      .split(";")[0]
      ?.slice(`${DESKTOP_SESSION_COOKIE_NAME}=`.length);
    expect(service.validateSession(session)).toBe(true);

    const replay = await routes.request(
      `http://127.0.0.1/${code}`,
      undefined,
      bindings,
    );
    expect(replay.status).toBe(404);
  });

  it("conceals the mint route from non-loopback or unauthenticated callers", async () => {
    const routes = createDesktopBootstrapRoutes(
      new DesktopBootstrapService({ masterSecret: MASTER_SECRET }),
    );

    const remote = await routes.request(
      "http://127.0.0.1/mint",
      {
        method: "POST",
        headers: {
          "x-yep-desktop-bootstrap-secret": MASTER_SECRET,
        },
      },
      socketBindings("192.0.2.8"),
    );
    const wrongSecret = await routes.request(
      "http://127.0.0.1/mint",
      {
        method: "POST",
        headers: {
          "x-yep-desktop-bootstrap-secret": "x".repeat(64),
        },
      },
      socketBindings(),
    );

    expect(remote.status).toBe(404);
    expect(wrongSecret.status).toBe(404);
  });
});
