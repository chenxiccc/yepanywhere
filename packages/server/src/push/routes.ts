/**
 * Push notification API routes
 */

import { Hono } from "hono";
import { structuredErrorHandler } from "../middleware/error-handler.js";
import type { PushService } from "./PushService.js";
import type {
  NotificationSettings,
  PushDeliveryUrgency,
  PushSubscription,
} from "./types.js";

export interface PushRoutesDeps {
  pushService: PushService;
}

interface SubscribeBody {
  browserProfileId: string;
  subscription: PushSubscription;
  deviceName?: string;
}

interface UnsubscribeBody {
  browserProfileId: string;
}

interface TestPushBody {
  browserProfileId: string;
  message?: string;
  urgency?: "normal" | "persistent" | "silent";
  deliveryUrgency?: PushDeliveryUrgency;
}

type PushDeviceType = "android" | "ios" | "mobile" | "desktop" | "unknown";
const PUSH_DELIVERY_URGENCIES = new Set<PushDeliveryUrgency>([
  "very-low",
  "low",
  "normal",
  "high",
]);

export function createPushRoutes(deps: PushRoutesDeps): Hono {
  const app = new Hono();
  // When mounted, Hono routes a thrown error to the root app's handler (the
  // same structuredErrorHandler, installed in app.ts); this local install
  // covers direct requests against the unmounted sub-app, as in tests.
  app.onError(structuredErrorHandler);
  const { pushService } = deps;

  /**
   * GET /api/push/vapid-public-key
   * Returns the VAPID public key for client subscription
   */
  app.get("/vapid-public-key", (c) => {
    const publicKey = pushService.getPublicKey();

    if (!publicKey) {
      return c.json(
        {
          error: "VAPID keys not configured",
          hint: "Run 'pnpm setup-vapid' to generate keys",
        },
        503,
      );
    }

    return c.json({ publicKey });
  });

  /**
   * POST /api/push/subscribe
   * Subscribe a browser profile for push notifications
   */
  app.post("/subscribe", async (c) => {
    const body = await c.req.json<SubscribeBody>();

    if (!body.browserProfileId || typeof body.browserProfileId !== "string") {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    if (!body.subscription?.endpoint || !body.subscription?.keys) {
      return c.json({ error: "Valid subscription object is required" }, 400);
    }

    const userAgent = c.req.header("User-Agent");

    await pushService.subscribe(body.browserProfileId, body.subscription, {
      userAgent,
      deviceName: body.deviceName,
    });

    return c.json({
      success: true,
      browserProfileId: body.browserProfileId,
    });
  });

  /**
   * POST /api/push/unsubscribe
   * Unsubscribe a browser profile from push notifications
   */
  app.post("/unsubscribe", async (c) => {
    const body = await c.req.json<UnsubscribeBody>();

    if (!body.browserProfileId || typeof body.browserProfileId !== "string") {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    const removed = await pushService.unsubscribe(body.browserProfileId);

    return c.json({
      success: removed,
      browserProfileId: body.browserProfileId,
    });
  });

  /**
   * GET /api/push/subscriptions
   * List all push subscriptions (for settings UI)
   */
  app.get("/subscriptions", (c) => {
    const subscriptions = pushService.getSubscriptions();

    // Return sanitized subscription info (hide sensitive keys)
    const sanitized = Object.entries(subscriptions).map(
      ([browserProfileId, sub]) => {
        // Safely extract domain from endpoint
        let endpointDomain = "unknown";
        try {
          if (sub.subscription?.endpoint) {
            endpointDomain = new URL(sub.subscription.endpoint).hostname;
          }
        } catch {
          // Invalid URL, keep "unknown"
        }

        return {
          browserProfileId,
          createdAt: sub.createdAt,
          deviceName: sub.deviceName,
          endpointDomain,
          deviceType: inferDeviceType(sub.deviceName, sub.userAgent),
        };
      },
    );

    return c.json({
      count: sanitized.length,
      subscriptions: sanitized,
    });
  });

  /**
   * DELETE /api/push/subscriptions/:browserProfileId
   * Remove a specific subscription
   */
  app.delete("/subscriptions/:browserProfileId", async (c) => {
    const browserProfileId = c.req.param("browserProfileId");
    if (!browserProfileId) {
      return c.json({ error: "browserProfileId is required" }, 400);
    }
    const removed = await pushService.unsubscribe(browserProfileId);

    if (!removed) {
      return c.json({ error: "Subscription not found" }, 404);
    }

    return c.json({ success: true });
  });

  /**
   * POST /api/push/test
   * Send a test notification (for debugging)
   */
  app.post("/test", async (c) => {
    const body = await c.req.json<TestPushBody>();

    if (!body.browserProfileId) {
      return c.json({ error: "browserProfileId is required" }, 400);
    }

    const result = await pushService.sendTest(
      body.browserProfileId,
      body.message ?? "Test notification from Yep Anywhere",
      body.urgency,
      normalizeDeliveryUrgency(body.deliveryUrgency),
    );

    if (!result.success) {
      return c.json(
        {
          success: false,
          error: result.error,
          statusCode: result.statusCode,
        },
        result.statusCode === 404 || result.statusCode === 410 ? 410 : 500,
      );
    }

    return c.json({ success: true });
  });

  /**
   * GET /api/push/settings
   * Get notification settings (what types of notifications are sent)
   */
  app.get("/settings", (c) => {
    const settings = pushService.getNotificationSettings();
    return c.json({ settings });
  });

  /**
   * PUT /api/push/settings
   * Update notification settings
   */
  app.put("/settings", async (c) => {
    const body = await c.req.json<Partial<NotificationSettings>>();

    // Validate that we got at least one setting
    const validKeys = [
      "toolApproval",
      "userQuestion",
      "sessionHalted",
      "projectInactive",
      "yaInactive",
    ] as const;
    const updates: Partial<NotificationSettings> = {};

    for (const key of validKeys) {
      if (typeof body[key] === "boolean") {
        updates[key] = body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "At least one valid setting is required" }, 400);
    }

    const settings = await pushService.setNotificationSettings(updates);
    return c.json({ settings });
  });

  return app;
}

function normalizeDeliveryUrgency(
  value: PushDeliveryUrgency | undefined,
): PushDeliveryUrgency | undefined {
  if (value && PUSH_DELIVERY_URGENCIES.has(value)) {
    return value;
  }
  return undefined;
}

function inferDeviceType(
  deviceName: string | undefined,
  userAgent: string | undefined,
): PushDeviceType {
  const text = `${deviceName ?? ""} ${userAgent ?? ""}`.toLowerCase();
  if (/\bandroid\b/.test(text)) return "android";
  if (/\biphone\b|\bipad\b|\bipod\b/.test(text)) return "ios";
  if (/\bmobile\b/.test(text)) return "mobile";
  if (/\bmac\b|\bwindows\b|\blinux\b|\bcros\b/.test(text)) return "desktop";
  return "unknown";
}
