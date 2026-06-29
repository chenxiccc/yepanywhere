/**
 * 钉钉/飞书适配器 barrel + 平台自动检测
 * DingTalk/Feishu adapter barrel + platform auto-detection
 */

import { dingtalkAdapter } from "./dingtalk.js";
import { feishuAdapter } from "./feishu.js";
import type { AdapterPlatform, WebhookAdapter } from "./types.js";

export { dingtalkAdapter, feishuAdapter };
export type { AdapterPlatform, WebhookAdapter, WebhookAdapterRequest } from "./types.js";

/**
 * 按 URL 域名自动检测目标平台 / Auto-detect the target platform by URL host
 *
 * - `oapi.dingtalk.com` → dingtalk
 * - `open.feishu.cn` → feishu
 * - 其他 → unknown（调用方应拒绝发送）
 *   others → unknown (caller should skip sending)
 */
export function detectPlatform(url: string): AdapterPlatform | "unknown" {
  const lower = url.toLowerCase();
  if (lower.includes("oapi.dingtalk.com")) return "dingtalk";
  if (lower.includes("open.feishu.cn")) return "feishu";
  return "unknown";
}

/**
 * 按平台标识取适配器 / Get the adapter for a given platform
 */
export function getAdapter(platform: AdapterPlatform): WebhookAdapter {
  return platform === "dingtalk" ? dingtalkAdapter : feishuAdapter;
}
