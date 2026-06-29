/**
 * 钉钉群机器人适配器 / DingTalk group-bot adapter
 *
 * 签名算法（按钉钉官方文档）：
 * Signing algorithm (per DingTalk official docs):
 *   - timestamp 单位：毫秒 / timestamp unit: milliseconds
 *   - HMAC key：secret
 *   - HMAC message：`timestamp + "\n" + secret`
 *   - 编码：Base64 后再做 URL encode（encodeURIComponent）
 *   - 签名位置：URL query string（&timestamp=&sign=）
 *
 * 消息形态：markdown（msgtype: "markdown"）
 * Message format: markdown (msgtype: "markdown")
 */

import type { WebhookAdapter, WebhookAdapterRequest } from "./types.js";
import type { WebhookPrivatePayload } from "../types.js";

/** 把二进制 buffer 转成 Base64 字符串 / Convert a binary buffer to a Base64 string */
function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) {
    binary += String.fromCharCode(bytes[i] as number);
  }
  // btoa 在 Node 18+ 全局可用 / btoa is globally available in Node 18+
  return btoa(binary);
}

/**
 * 计算钉钉加签 / Compute the DingTalk signature
 * @param secret 加签密钥 / Signing secret
 * @param timestampMs 可选毫秒时间戳，默认当前时间（测试可注入固定值）
 *                    Optional millisecond timestamp; defaults to now (injectable for tests)
 * @returns timestamp（毫秒字符串）与 sign（已 URL encode）
 */
export async function signDingtalk(
  secret: string,
  timestampMs?: number,
): Promise<{ timestamp: string; sign: string }> {
  // 钉钉 timestamp 为毫秒 / DingTalk timestamp is in milliseconds
  const timestamp = (timestampMs ?? Date.now()).toString();
  // message = timestamp + "\n" + secret
  const stringToSign = `${timestamp}\n${secret}`;
  const encoder = new TextEncoder();
  // key 是 secret / key is the secret
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBuf = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(stringToSign),
  );
  // Base64 后 URL encode（+ / = 等字符需要转义）/ Base64 then URL-encode
  const sign = encodeURIComponent(bufferToBase64(sigBuf));
  return { timestamp, sign };
}

/** 事件类型到中文标签的映射 / Map event type to a Chinese label */
function eventLabel(event: WebhookPrivatePayload["event"]): string {
  switch (event) {
    case "idle":
      return "会话空闲";
    case "error":
      return "进程异常";
    case "tool-approval":
      return "权限审批";
    case "user-question":
      return "用户提问";
    default:
      return event;
  }
}

/**
 * 把 payload 渲染成钉钉 markdown 正文 / Render payload into DingTalk markdown text
 */
function renderMarkdown(payload: WebhookPrivatePayload): string {
  const lines: string[] = [];
  lines.push(`### Yep 通知：${eventLabel(payload.event)}`);
  lines.push("");
  lines.push(`**项目：** ${payload.project.name}`);
  lines.push("");
  lines.push(`**会话：** ${payload.session.id}`);
  lines.push("");
  lines.push(`**事件：** ${eventLabel(payload.event)}`);
  if (payload.reason) {
    lines.push("");
    lines.push(`**原因：** ${payload.reason}`);
  }
  if (payload.summary) {
    lines.push("");
    lines.push(`**摘要：** ${payload.summary}`);
  }
  if (payload.lastUserMessageText) {
    lines.push("");
    lines.push(`> **最后用户消息：** ${payload.lastUserMessageText}`);
  }
  if (payload.lastMessageText) {
    lines.push("");
    lines.push(`> **最后助手消息：** ${payload.lastMessageText}`);
  }
  if (payload.process) {
    lines.push("");
    const provider = payload.process.provider ?? "unknown";
    const model = payload.process.model ?? "unknown";
    lines.push(`**Provider：** ${provider} / ${model}`);
  }
  lines.push("");
  lines.push(`**时间：** ${payload.timestamp}`);
  if (payload.dryRun) {
    lines.push("");
    lines.push("> _（试运行 dryRun，未真实触发）_");
  }
  return lines.join("\n");
}

/** 通知栏标题 / Notification title */
function buildTitle(payload: WebhookPrivatePayload): string {
  return `Yep：${eventLabel(payload.event)} · ${payload.project.name}`;
}

/** 钉钉适配器实例 / DingTalk adapter instance */
export const dingtalkAdapter: WebhookAdapter = {
  platform: "dingtalk",

  async buildRequest(
    payload: WebhookPrivatePayload,
    baseUrl: string,
    secret: string,
  ): Promise<WebhookAdapterRequest> {
    const body = {
      msgtype: "markdown" as const,
      markdown: {
        title: buildTitle(payload),
        text: renderMarkdown(payload),
      },
    };

    // 无 secret 时不加签，直接用原 URL / No signing when secret is empty
    if (!secret) {
      return {
        url: baseUrl,
        body,
        headers: { "content-type": "application/json" },
      };
    }

    const { timestamp, sign } = await signDingtalk(secret);
    // 把 timestamp 与 sign 追加到 URL query（兼容原 URL 已有 query 的情况）
    // Append timestamp & sign to the URL query (handles pre-existing query string)
    const separator = baseUrl.includes("?") ? "&" : "?";
    const url = `${baseUrl}${separator}timestamp=${timestamp}&sign=${sign}`;

    return {
      url,
      body,
      headers: { "content-type": "application/json" },
    };
  },
};
