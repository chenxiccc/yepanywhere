/**
 * 钉钉/飞书群机器人 webhook 通知 —— 类型定义
 * DingTalk/Feishu group-bot webhook notification — type definitions
 *
 * 完全独立于现有 LifecycleWebhookService，配置存独立文件 webhook-private.json。
 * Fully independent of the existing LifecycleWebhookService; config is stored
 * in a dedicated webhook-private.json file.
 */

import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";

/** 会触发群机器人通知的事件类型 / Event types that trigger group-bot notifications */
export type WebhookEventType =
  | "idle"
  | "error"
  | "tool-approval"
  | "user-question";

/** 目标平台。auto 表示按 URL 域名自动识别 / Target platform; "auto" detects by URL host */
export type WebhookPlatform = "auto" | "dingtalk" | "feishu";

/**
 * webhook-private.json 的持久化结构 / Persisted structure of webhook-private.json
 */
export interface WebhookPrivateConfig {
  /** Schema 版本 / Schema version */
  version: 1;
  /** 总开关 / Master switch */
  enabled: boolean;
  /** 群机器人 webhook URL / Group-bot webhook URL */
  url: string;
  /** 加签密钥（可选，启用加签时填写）/ Signing secret (optional, required when signing is enabled) */
  secret: string;
  /** 平台选择，默认 auto / Platform selection, defaults to "auto" */
  platform: WebhookPlatform;
  /** 各事件类型开关 / Per-event-type toggles */
  events: {
    idle: boolean;
    error: boolean;
    toolApproval: boolean;
    userQuestion: boolean;
  };
  /** 试运行模式：仍发送但 payload.dryRun=true / Dry-run: still sends but marks payload.dryRun=true */
  dryRun: boolean;
}

/** 新文件或缺失字段时的默认配置 / Defaults for new or missing preference files */
export const DEFAULT_WEBHOOK_PRIVATE_CONFIG: WebhookPrivateConfig = {
  version: 1,
  enabled: false,
  url: "",
  secret: "",
  platform: "auto",
  events: {
    idle: true,
    error: true,
    toolApproval: true,
    userQuestion: true,
  },
  dryRun: true,
};

/** 当前 schema 版本 / Current schema version */
export const WEBHOOK_PRIVATE_CONFIG_VERSION = 1;

/**
 * 平台无关的中间 payload 表示，交给适配器转换成各平台格式。
 * Platform-agnostic intermediate payload; adapters convert it into each
 * platform's wire format.
 */
export interface WebhookPrivatePayload {
  /** 固定类型标识 / Fixed type tag */
  type: "session-inactive";
  /** 触发事件 / Triggering event */
  event: WebhookEventType;
  /** ISO 时间戳 / ISO timestamp */
  timestamp: string;
  /** 是否试运行 / Dry-run flag */
  dryRun: boolean;
  /** 会话信息 / Session info */
  session: { id: string };
  /** 项目信息 / Project info */
  project: { id: UrlProjectId; path: string; name: string };
  /** 进程信息 / Process info */
  process?: {
    id: string;
    provider?: ProviderName;
    model?: string;
    executor?: string;
    permissionMode?: string;
  };
  /** error 事件时的原因文本 / Reason text for the error event */
  reason?: string;
  /** 简要摘要 / Brief summary */
  summary?: string;
  /** 最后一条用户消息文本 / Last user message text */
  lastUserMessageText?: string;
  /** 最后一条助手消息文本 / Last assistant message text */
  lastMessageText?: string;
}
