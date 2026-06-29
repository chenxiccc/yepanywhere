import { describe, expect, it, vi } from "vitest";
import { createWebhookPrivateRoutes } from "../../src/webhook-private/routes.js";
import type { WebhookPrivateConfigStore } from "../../src/webhook-private/WebhookPrivateConfigStore.js";
import type { WebhookPrivateService } from "../../src/webhook-private/WebhookPrivateService.js";
import { DEFAULT_WEBHOOK_PRIVATE_CONFIG } from "../../src/webhook-private/types.js";

function makeDeps(overrides: Partial<{
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  sendTest: ReturnType<typeof vi.fn>;
}>) {
  const store = {
    get: overrides.get ?? vi.fn(() => ({ ...DEFAULT_WEBHOOK_PRIVATE_CONFIG })),
    update:
      overrides.update ??
      vi.fn(async (patch: unknown) => ({ ...DEFAULT_WEBHOOK_PRIVATE_CONFIG, ...(patch as object) })),
  } as unknown as WebhookPrivateConfigStore;
  const service = {
    sendTest:
      overrides.sendTest ?? vi.fn(async () => ({ success: true })),
  } as unknown as WebhookPrivateService;
  return { store, service };
}

describe("webhook-private routes", () => {
  describe("GET /", () => {
    it("returns the current config", async () => {
      const { store, service } = makeDeps({
        get: vi.fn(() => ({ ...DEFAULT_WEBHOOK_PRIVATE_CONFIG, enabled: true })),
      });
      const routes = createWebhookPrivateRoutes({ store, service });

      const res = await routes.request("/", { method: "GET" });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { config: { enabled: boolean } };
      expect(json.config.enabled).toBe(true);
    });
  });

  describe("PUT /", () => {
    it("updates config via the store and returns the merged result", async () => {
      const update = vi.fn(async () => ({
        ...DEFAULT_WEBHOOK_PRIVATE_CONFIG,
        enabled: true,
        url: "https://oapi.dingtalk.com/robot/send?access_token=x",
      }));
      const { store, service } = makeDeps({ update });
      const routes = createWebhookPrivateRoutes({ store, service });

      const res = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, url: "https://oapi.dingtalk.com/robot/send?access_token=x" }),
      });

      expect(res.status).toBe(200);
      expect(update).toHaveBeenCalledWith({
        enabled: true,
        url: "https://oapi.dingtalk.com/robot/send?access_token=x",
      });
      const json = (await res.json()) as { config: { enabled: boolean; url: string } };
      expect(json.config.enabled).toBe(true);
      expect(json.config.url).toContain("oapi.dingtalk.com");
    });
  });

  describe("POST /test", () => {
    it("returns success when sendTest succeeds", async () => {
      const { store, service } = makeDeps({
        sendTest: vi.fn(async () => ({ success: true })),
      });
      const routes = createWebhookPrivateRoutes({ store, service });

      const res = await routes.request("/test", { method: "POST" });
      expect(res.status).toBe(200);
      const json = (await res.json()) as { success: boolean };
      expect(json.success).toBe(true);
    });

    it("returns 500 with error when sendTest fails", async () => {
      const { store, service } = makeDeps({
        sendTest: vi.fn(async () => ({
          success: false,
          error: "boom",
          statusCode: 500,
        })),
      });
      const routes = createWebhookPrivateRoutes({ store, service });

      const res = await routes.request("/test", { method: "POST" });
      expect(res.status).toBe(500);
      const json = (await res.json()) as {
        success: boolean;
        error: string;
        statusCode: number;
      };
      expect(json.success).toBe(false);
      expect(json.error).toBe("boom");
    });
  });
});
