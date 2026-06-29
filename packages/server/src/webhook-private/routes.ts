/**
 * webhook-private REST API 路由 / webhook-private REST API routes
 *
 * 仿 push/routes.ts 结构。端点：
 * Modeled after push/routes.ts. Endpoints:
 *   GET  /            取当前配置 / get current config
 *   PUT  /            更新配置（白名单字段）/ update config (whitelisted fields)
 *   POST /test        用当前配置发一条测试消息 / send a test message with current config
 */

import { Hono } from "hono";
import type { WebhookPrivateConfigStore } from "./WebhookPrivateConfigStore.js";
import type { WebhookPrivateService } from "./WebhookPrivateService.js";
import type { WebhookPrivateConfig } from "./types.js";

export interface WebhookPrivateRoutesDeps {
  /** 配置存储 / Config store */
  store: WebhookPrivateConfigStore;
  /** 服务（用于发送测试消息）/ Service (used to send the test message) */
  service: WebhookPrivateService;
}

export function createWebhookPrivateRoutes(
  deps: WebhookPrivateRoutesDeps,
): Hono {
  const app = new Hono();
  const { store, service } = deps;

  /**
   * GET /api/webhook-private
   * 取当前配置 / Get the current config
   */
  app.get("/", (c) => {
    return c.json({ config: store.get() });
  });

  /**
   * PUT /api/webhook-private
   * 更新配置（白名单字段合并）/ Update config (merge whitelisted fields)
   */
  app.put("/", async (c) => {
    const patch = await c.req.json<Partial<WebhookPrivateConfig>>();
    const config = await store.update(patch);
    return c.json({ config });
  });

  /**
   * POST /api/webhook-private/test
   * 用当前配置发一条测试消息 / Send a test message with the current config
   */
  app.post("/test", async (c) => {
    const result = await service.sendTest();
    if (!result.success) {
      return c.json(
        {
          success: false,
          error: result.error,
          statusCode: result.statusCode,
        },
        500,
      );
    }
    return c.json({ success: true });
  });

  return app;
}
