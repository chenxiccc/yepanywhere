import type { HttpBindings } from "@hono/node-server";
import { type Context, Hono } from "hono";
import { setCookie } from "hono/cookie";
import {
  DESKTOP_SESSION_COOKIE_NAME,
  type DesktopBootstrapService,
} from "../desktop/DesktopBootstrapService.js";

const MASTER_SECRET_HEADER = "x-yep-desktop-bootstrap-secret";

function isLoopbackAddress(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase().split("%", 1)[0];
  return (
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "::ffff:127.0.0.1"
  );
}

export function isLoopbackDesktopRequest(
  c: Context<{ Bindings: HttpBindings }>,
): boolean {
  const incoming = c.env?.incoming;
  const socket = incoming?.socket;
  return (
    isLoopbackAddress(socket?.remoteAddress) &&
    isLoopbackAddress(socket?.localAddress)
  );
}

function shouldUseSecureCookie(url: string): boolean {
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

export function createDesktopBootstrapRoutes(
  service: DesktopBootstrapService,
): Hono<{ Bindings: HttpBindings }> {
  const routes = new Hono<{ Bindings: HttpBindings }>();

  routes.post("/mint", (c) => {
    if (!isLoopbackDesktopRequest(c)) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!service.canAttemptBootstrap()) {
      return c.json({ error: "Not found" }, 404);
    }
    if (!service.validateMasterSecret(c.req.header(MASTER_SECRET_HEADER))) {
      return c.json({ error: "Not found" }, 404);
    }
    return c.json(service.mintCode());
  });

  routes.get("/:code", (c) => {
    if (!isLoopbackDesktopRequest(c)) {
      return c.text("Not found", 404);
    }
    if (!service.canAttemptBootstrap()) {
      return c.text("Too many attempts", 429);
    }

    const session = service.consumeCode(c.req.param("code"));
    if (!session) {
      return c.text("Invalid or expired desktop bootstrap", 404);
    }

    setCookie(c, DESKTOP_SESSION_COOKIE_NAME, session, {
      httpOnly: true,
      sameSite: "Strict",
      secure: shouldUseSecureCookie(c.req.url),
      path: "/",
    });
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect("/", 303);
  });

  return routes;
}
