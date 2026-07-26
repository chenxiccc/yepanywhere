import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../src/middleware/error-handler.js";
import { createPushRoutes } from "../../src/push/routes.js";
import type { PushService } from "../../src/push/PushService.js";

describe("Push Routes", () => {
  describe("PUT /settings", () => {
    it("accepts inactivity notification settings", async () => {
      const setNotificationSettings = vi.fn(async (updates) => ({
        toolApproval: true,
        userQuestion: true,
        sessionHalted: false,
        projectInactive: updates.projectInactive === true,
        yaInactive: updates.yaInactive === true,
      }));
      const routes = createPushRoutes({
        pushService: {
          setNotificationSettings,
        } as unknown as PushService,
      });

      const response = await routes.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectInactive: true,
          yaInactive: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(setNotificationSettings).toHaveBeenCalledWith({
        projectInactive: true,
        yaInactive: true,
      });
      await expect(response.json()).resolves.toEqual({
        settings: {
          toolApproval: true,
          userQuestion: true,
          sessionHalted: false,
          projectInactive: true,
          yaInactive: true,
        },
      });
    });

    it("ignores unknown and non-boolean settings", async () => {
      const setNotificationSettings = vi.fn(async (updates) => ({
        toolApproval: true,
        userQuestion: true,
        sessionHalted: false,
        projectInactive: updates.projectInactive === true,
        yaInactive: false,
      }));
      const routes = createPushRoutes({
        pushService: {
          setNotificationSettings,
        } as unknown as PushService,
      });

      const response = await routes.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectInactive: true,
          yaInactive: "yes",
          unknownSetting: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(setNotificationSettings).toHaveBeenCalledWith({
        projectInactive: true,
      });
    });

    it("rejects payloads without any valid setting", async () => {
      const setNotificationSettings = vi.fn();
      const routes = createPushRoutes({
        pushService: {
          setNotificationSettings,
        } as unknown as PushService,
      });

      const response = await routes.request("/settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaInactive: "yes",
          unknownSetting: true,
        }),
      });

      expect(response.status).toBe(400);
      expect(setNotificationSettings).not.toHaveBeenCalled();
      await expect(response.json()).resolves.toEqual({
        error: "At least one valid setting is required",
      });
    });
  });

  // Regression for issue #84: a throw in a push route must surface its real
  // reason instead of an opaque "API error: 500" the client can't diagnose.
  describe("error boundary (issue #84)", () => {
    const subscribeBody = JSON.stringify({
      browserProfileId: "prof-1",
      subscription: {
        endpoint: "https://push.example.com/ep",
        keys: { p256dh: "p", auth: "a" },
      },
    });

    it("returns the real error message when subscribe throws", async () => {
      const routes = createPushRoutes({
        pushService: {
          subscribe: vi.fn(async () => {
            throw new Error(
              "EACCES: permission denied, open 'push-subscriptions.json'",
            );
          }),
        } as unknown as PushService,
      });

      const response = await routes.request("/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: subscribeBody,
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "EACCES: permission denied, open 'push-subscriptions.json'",
      });
    });

    it("maps an uninitialized service to 503 with the reason", async () => {
      // The 503 rides on the typed HttpError PushService throws, not on the
      // message text — matching ensureInitialized in PushService.ts.
      const routes = createPushRoutes({
        pushService: {
          subscribe: vi.fn(async () => {
            throw new HttpError(
              503,
              "PushService not initialized. Call initialize() first.",
            );
          }),
        } as unknown as PushService,
      });

      const response = await routes.request("/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: subscribeBody,
      });

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toContain("not initialized");
    });

    it("passes through a web-push statusCode when one escapes", async () => {
      const routes = createPushRoutes({
        pushService: {
          subscribe: vi.fn(async () => {
            const err = new Error(
              "Received unexpected response code",
            ) as Error & {
              statusCode: number;
            };
            err.statusCode = 403;
            throw err;
          }),
        } as unknown as PushService,
      });

      const response = await routes.request("/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: subscribeBody,
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({
        error: "Received unexpected response code",
        statusCode: 403,
      });
    });
  });
});
