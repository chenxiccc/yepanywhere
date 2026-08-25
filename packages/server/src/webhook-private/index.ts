/**
 * webhook-private barrel —— 钉钉/飞书群机器人通知模块
 * webhook-private barrel — DingTalk/Feishu group-bot notification module
 */

export { WebhookPrivateConfigStore } from "./WebhookPrivateConfigStore.js";
export type { WebhookPrivateConfigStoreOptions } from "./WebhookPrivateConfigStore.js";
export { WebhookPrivateService } from "./WebhookPrivateService.js";
export type { WebhookPrivateServiceOptions } from "./WebhookPrivateService.js";
export { createWebhookPrivateRoutes } from "./routes.js";
export type { WebhookPrivateRoutesDeps } from "./routes.js";
export {
  DEFAULT_WEBHOOK_PRIVATE_CONFIG,
  WEBHOOK_PRIVATE_CONFIG_VERSION,
} from "./types.js";
export type {
  WebhookEventType,
  WebhookPlatform,
  WebhookPrivateConfig,
  WebhookPrivatePayload,
} from "./types.js";
export { detectPlatform, getAdapter, dingtalkAdapter, feishuAdapter } from "./adapters/index.js";
export type { AdapterPlatform, WebhookAdapter, WebhookAdapterRequest } from "./adapters/index.js";
