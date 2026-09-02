/**
 * 飞书群机器人适配器 / Feishu (Lark) group-bot adapter
 *
 * 签名算法（按飞书官方文档，与钉钉的关键区别）：
 * Signing algorithm (per Feishu official docs; key differences vs DingTalk):
 *   - timestamp 单位：秒 / timestamp unit: seconds
 *   - HMAC key：`timestamp + "\n" + secret`（即整个 stringToSign 作为 key）
 *     HMAC key: `timestamp + "\n" + secret` (the whole stringToSign is the key)
 *   - HMAC message：空串 / HMAC message: empty string
 *   - 编码：Base64，**不做** URL encode / Base64, **no** URL-encode
 *   - 签名位置：JSON body 顶层（{ timestamp, sign, ... }）
 *     Signature placement: top-level of the JSON body ({ timestamp, sign, ... })
 *
 * 消息形态：interactive（消息卡片） / Message format: interactive (card)
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
  return btoa(binary);
}

/**
 * 计算飞书加签 / Compute the Feishu signature
 * @param secret 加签密钥 / Signing secret
 * @param timestampSec 可选秒时间戳，默认当前时间（测试可注入固定值）
 *                     Optional second timestamp; defaults to now (injectable for tests)
 * @returns timestamp（秒字符串）与 sign（Base64，不 URL encode）
 */
export async function signFeishu(
  secret: string,
  timestampSec?: number,
): Promise<{ timestamp: string; sign: string }> {
  // 飞书 timestamp 为秒 / Feishu timestamp is in seconds
  const timestamp = (timestampSec ?? Math.floor(Date.now() / 1000)).toString();
  // key = timestamp + "\n" + secret（注意：飞书的 key 是整个 stringToSign）
  // key = timestamp + "\n" + secret (Feishu uses the whole stringToSign as key)
  const stringToSign = `${timestamp}\n${secret}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(stringToSign),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  // message 为空串 / message is an empty string
  const sigBuf = await crypto.subtle.sign("HMAC", key, new Uint8Array(0));
  // Base64，不 URL encode / Base64, no URL-encode
  const sign = bufferToBase64(sigBuf);
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

/** 卡片头部颜色模板（按事件类型）/ Card header color template by event type */
function headerTemplate(
  event: WebhookPrivatePayload["event"],
): "green" | "red" | "blue" | "orange" {
  switch (event) {
    case "error":
      return "red";
    case "tool-approval":
      return "orange";
    case "user-question":
      return "blue";
    default:
      // idle 及未知事件统一用绿色 / idle and unknown events use green
      return "green";
  }
}

/**
 * 构建 lark_md 文本块 / Build a lark_md text div element
 */
function mdDiv(content: string): {
  tag: "div";
  text: { tag: "lark_md"; content: string };
} {
  return { tag: "div", text: { tag: "lark_md", content } };
}

/**
 * 把 payload 渲染成飞书消息卡片 elements / Render payload into Feishu card elements
 */
function renderElements(payload: WebhookPrivatePayload): unknown[] {
  const elements: unknown[] = [
    mdDiv(`**项目：** ${payload.project.name}`),
    mdDiv(`**会话：** ${payload.session.id}`),
    mdDiv(`**事件：** ${eventLabel(payload.event)}`),
  ];

  if (payload.reason) {
    elements.push(mdDiv(`**原因：** ${payload.reason}`));
  }
  if (payload.summary) {
    elements.push(mdDiv(`**摘要：** ${payload.summary}`));
  }
  if (payload.lastUserMessageText) {
    elements.push(mdDiv(`**最后用户消息：** ${payload.lastUserMessageText}`));
  }
  if (payload.lastMessageText) {
    elements.push(mdDiv(`**最后助手消息：** ${payload.lastMessageText}`));
  }
  if (payload.process) {
    const provider = payload.process.provider ?? "unknown";
    const model = payload.process.model ?? "unknown";
    elements.push(mdDiv(`**Provider：** ${provider} / ${model}`));
  }

  elements.push({ tag: "hr" });
  elements.push(mdDiv(`**时间：** ${payload.timestamp}`));
  if (payload.dryRun) {
    elements.push(mdDiv("_（试运行 dryRun，未真实触发）_"));
  }
  return elements;
}

/** 卡片标题 / Card title */
function buildTitle(payload: WebhookPrivatePayload): string {
  return `Yep：${eventLabel(payload.event)} · ${payload.project.name}`;
}

/** 飞书适配器实例 / Feishu adapter instance */
export const feishuAdapter: WebhookAdapter = {
  platform: "feishu",

  async buildRequest(
    payload: WebhookPrivatePayload,
    baseUrl: string,
    secret: string,
  ): Promise<WebhookAdapterRequest> {
    const card = {
      config: { wide_screen_mode: true },
      header: {
        title: { tag: "plain_text" as const, content: buildTitle(payload) },
        template: headerTemplate(payload.event),
      },
      elements: renderElements(payload),
    };

    // 无 secret 时不加签 / No signing when secret is empty
    if (!secret) {
      return {
        url: baseUrl,
        body: { msg_type: "interactive" as const, card },
        headers: { "content-type": "application/json" },
      };
    }

    // 签名放在 body 顶层 / Signature goes at the top level of the body
    const { timestamp, sign } = await signFeishu(secret);
    const body = {
      timestamp,
      sign,
      msg_type: "interactive" as const,
      card,
    };

    return {
      url: baseUrl,
      body,
      headers: { "content-type": "application/json" },
    };
  },
};
