/**
 * WebhookPrivateService —— 钉钉/飞书群机器人通知服务
 * WebhookPrivateService — DingTalk/Feishu group-bot notification service
 *
 * 订阅 EventBus，把会话事件（idle / error / tool-approval / user-question）
 * 转成平台无关 payload，再按 URL 域名分发到钉钉或飞书适配器发送。
 * Subscribes to the EventBus, converts session events (idle / error /
 * tool-approval / user-question) into a platform-agnostic payload, then
 * dispatches to the DingTalk or Feishu adapter based on the URL host.
 *
 * 完全独立于现有 LifecycleWebhookService：不改它，只复用其 payload 构建逻辑
 * （拷贝到本文件）。事件来源全部复用 EventBus 已有事件，不新增 BusEvent。
 * Fully independent of the existing LifecycleWebhookService: it is not
 * modified; only its payload-building logic is copied here. All events come
 * from existing EventBus events — no new BusEvent is added.
 */

import { basename } from "node:path";
import type { ProviderName, UrlProjectId } from "@yep-anywhere/shared";
import type { Supervisor } from "../supervisor/Supervisor.js";
import { decodeProjectId } from "../supervisor/types.js";
import type {
  BusEvent,
  EventBus,
  ProcessStateEvent,
  ProcessTerminatedEvent,
} from "../watcher/index.js";
import { detectPlatform, getAdapter } from "./adapters/index.js";
import { WebhookPrivateConfigStore } from "./WebhookPrivateConfigStore.js";
import type {
  WebhookEventType,
  WebhookPrivateConfig,
  WebhookPrivatePayload,
} from "./types.js";

export interface WebhookPrivateServiceOptions {
  /** 数据目录 / Data directory */
  dataDir: string;
  /** 事件总线 / Event bus */
  eventBus: EventBus;
  /** 进程管理器 / Process supervisor */
  supervisor: Supervisor;
}

/** dispatch 上下文 / dispatch context */
interface DispatchContext {
  process?: {
    id: string;
    provider?: ProviderName;
    model?: string;
    executor?: string;
    permissionMode?: string;
  };
  projectPath?: string;
  summary?: string;
}

export class WebhookPrivateService {
  private readonly store: WebhookPrivateConfigStore;
  private readonly unsubscribe: () => void;

  constructor(private readonly options: WebhookPrivateServiceOptions) {
    this.store = new WebhookPrivateConfigStore({ dataDir: options.dataDir });
    // 订阅 EventBus，与 LifecycleWebhookService 同样的轻量模式
    // Subscribe to the EventBus (same lightweight pattern as LifecycleWebhookService)
    this.unsubscribe = this.options.eventBus.subscribe((event) => {
      void this.handleEvent(event);
    });
  }

  /** 从盘加载配置 / Load config from disk */
  async initialize(): Promise<void> {
    await this.store.initialize();
  }

  /** 退订 EventBus / Unsubscribe from the EventBus */
  dispose(): void {
    this.unsubscribe();
  }

  /** 给路由用的 store 引用 / Store reference for routes */
  getStore(): WebhookPrivateConfigStore {
    return this.store;
  }

  /**
   * 用当前配置发一条测试消息 / Send a test message with the current config
   *
   * 供 POST /api/webhook-private/test 端点使用。
   * Used by the POST /api/webhook-private/test endpoint.
   */
  async sendTest(): Promise<{
    success: boolean;
    error?: string;
    statusCode?: number;
  }> {
    const config = this.store.get();
    const payload: WebhookPrivatePayload = {
      type: "session-inactive",
      event: "idle",
      timestamp: new Date().toISOString(),
      dryRun: true,
      session: { id: "test-session" },
      project: {
        id: "" as UrlProjectId,
        path: "/test",
        name: "Test",
      },
      summary: "Yep 群机器人 webhook 测试消息",
    };
    return this.send(config, payload);
  }

  private async handleEvent(event: BusEvent): Promise<void> {
    if (event.type === "process-state-changed") {
      await this.handleProcessStateChanged(event);
      return;
    }
    if (event.type === "process-terminated") {
      await this.handleProcessTerminated(event);
    }
  }

  /**
   * 处理进程状态变更：idle 与 waiting-input（tool-approval / user-question）
   * Handle process state changes: idle and waiting-input (tool-approval / user-question)
   */
  private async handleProcessStateChanged(
    event: ProcessStateEvent,
  ): Promise<void> {
    const config = this.store.get();
    if (!config.enabled) return;

    // idle 分支 / idle branch
    if (event.activity === "idle") {
      if (!config.events.idle) return;
      const process = this.options.supervisor.getProcessForSession(
        event.sessionId,
      );
      // 过滤 unregister 时发出的 synthetic idle，只认进程仍在内存的可恢复状态
      // Ignore the synthetic idle emitted during unregister; only the live
      // transition when the process is still resumable in-memory.
      if (process?.state.type !== "idle") return;
      await this.dispatch(event, "idle", {
        process: this.toProcessInfo(process),
        projectPath: process.projectPath,
      });
      return;
    }

    // waiting-input 分支（LifecycleWebhookService 不处理，这里新增）
    // waiting-input branch (not handled by LifecycleWebhookService; added here)
    if (event.activity === "waiting-input") {
      const sub = event.pendingInputType;
      if (sub !== "tool-approval" && sub !== "user-question") return;
      const enabled =
        sub === "tool-approval"
          ? config.events.toolApproval
          : config.events.userQuestion;
      if (!enabled) return;
      const process = this.options.supervisor.getProcessForSession(
        event.sessionId,
      );
      await this.dispatch(event, sub, {
        process: process ? this.toProcessInfo(process) : undefined,
        projectPath: process?.projectPath,
      });
    }

    // in-turn / terminated：忽略 / in-turn / terminated: ignored
  }

  /**
   * 处理进程异常终止 / Handle unexpected process termination
   */
  private async handleProcessTerminated(
    event: ProcessTerminatedEvent,
  ): Promise<void> {
    const config = this.store.get();
    if (!config.enabled || !config.events.error) return;

    const process = this.options.supervisor.getProcessForSession(
      event.sessionId,
    );
    const projectPath =
      process?.projectPath ?? this.decodeProjectPath(event.projectId);
    if (!projectPath) return;

    await this.dispatch(event, "error", {
      process: {
        id: event.processId,
        provider: event.provider as ProviderName,
        model: process?.resolvedModel,
        executor: process?.executor,
        permissionMode: process?.permissionMode,
      },
      projectPath,
      summary: event.reason,
    });
  }

  /**
   * 构建 payload → 选适配器 → 发送 / Build payload → pick adapter → send
   */
  private async dispatch(
    event: ProcessStateEvent | ProcessTerminatedEvent,
    evtType: WebhookEventType,
    ctx: DispatchContext,
  ): Promise<void> {
    const config = this.store.get();
    const projectPath = ctx.projectPath ?? this.decodeProjectPath(event.projectId);
    if (!projectPath) return;

    const payload = this.buildPayload({
      sessionId: event.sessionId,
      projectId: event.projectId,
      timestamp: event.timestamp,
      event: evtType,
      dryRun: config.dryRun,
      summary: ctx.summary,
      projectPath,
      process: ctx.process,
      history: this.getMessageHistory(event.sessionId),
    });

    await this.send(config, payload);
  }

  /**
   * 实际发送：选适配器 → fetch POST / Actual send: pick adapter → fetch POST
   */
  private async send(
    config: WebhookPrivateConfig,
    payload: WebhookPrivatePayload,
  ): Promise<{ success: boolean; error?: string; statusCode?: number }> {
    const webhookUrl = config.url.trim();
    if (!webhookUrl) {
      return { success: false, error: "Webhook URL is not configured" };
    }

    // 平台选择：auto 时按域名检测 / Pick platform; "auto" detects by host
    const platform =
      config.platform === "auto"
        ? detectPlatform(webhookUrl)
        : config.platform;

    if (platform === "unknown") {
      const msg = `Unknown webhook platform for URL: ${webhookUrl}`;
      console.error(`[WebhookPrivate] ${msg}`);
      return { success: false, error: msg };
    }

    const adapter = getAdapter(platform);
    try {
      const { url, body, headers } = await adapter.buildRequest(
        payload,
        webhookUrl,
        config.secret.trim(),
      );
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.error(
          `[WebhookPrivate] ${platform} responded ${response.status}: ${text}`,
        );
        return {
          success: false,
          error: `${platform} responded ${response.status}: ${text}`,
          statusCode: response.status,
        };
      }

      // 钉钉/飞书即使 HTTP 200 也可能在 body 里返回业务错误，这里一并记录
      // DingTalk/Feishu may return business errors in the body even on HTTP 200
      const text = await response.text().catch(() => "");
      if (text) {
        const businessError = this.detectBusinessError(platform, text);
        if (businessError) {
          console.error(
            `[WebhookPrivate] ${platform} business error: ${businessError}`,
          );
          return { success: false, error: businessError };
        }
      }
      return { success: true };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[WebhookPrivate] send failed:", error);
      return { success: false, error: msg };
    }
  }

  /**
   * 解析钉钉/飞书 body 里的业务错误 / Parse business errors from DingTalk/Feishu body
   */
  private detectBusinessError(
    platform: "dingtalk" | "feishu",
    body: string,
  ): string | null {
    try {
      const data = JSON.parse(body) as Record<string, unknown>;
      if (platform === "dingtalk") {
        // 钉钉：errcode != 0 即失败 / DingTalk: errcode != 0 means failure
        const errcode = data.errcode;
        if (typeof errcode === "number" && errcode !== 0) {
          return `errcode ${errcode}: ${String(data.errmsg ?? "")}`;
        }
        return null;
      }
      // 飞书：code != 0 即失败（StatusCode 是冗余字段，看 code）
      // Feishu: code != 0 means failure (StatusCode is redundant; check code)
      const code = data.code;
      if (typeof code === "number" && code !== 0) {
        return `code ${code}: ${String(data.msg ?? "")}`;
      }
      return null;
    } catch {
      // 非 JSON 响应体，无法判断业务错误 / Non-JSON body; cannot parse business error
      return null;
    }
  }

  /**
   * 构建 payload（拷贝自 LifecycleWebhookService.buildPayload，reason 语义扩展为 event）
   * Build payload (copied from LifecycleWebhookService.buildPayload; the
   * reason semantics are extended to the event field).
   */
  private buildPayload(input: {
    sessionId: string;
    projectId: UrlProjectId;
    timestamp: string;
    event: WebhookEventType;
    dryRun: boolean;
    summary?: string;
    projectPath: string;
    process?: WebhookPrivatePayload["process"];
    history: Array<{
      type?: string;
      message?: { role?: string; content?: unknown };
    }>;
  }): WebhookPrivatePayload {
    return {
      type: "session-inactive",
      event: input.event,
      timestamp: input.timestamp,
      dryRun: input.dryRun,
      session: { id: input.sessionId },
      project: {
        id: input.projectId,
        path: input.projectPath,
        name: basename(input.projectPath),
      },
      process: input.process,
      summary: input.summary,
      lastUserMessageText: this.extractLastMessageText(input.history, "user"),
      lastMessageText: this.extractLastMessageText(input.history),
    };
  }

  /** 从 supervisor 取消息历史（可能为空数组）/ Get message history from supervisor (may be empty) */
  private getMessageHistory(sessionId: string): Array<{
    type?: string;
    message?: { role?: string; content?: unknown };
  }> {
    const process = this.options.supervisor.getProcessForSession(sessionId);
    return (process?.getMessageHistory() ?? []) as Array<{
      type?: string;
      message?: { role?: string; content?: unknown };
    }>;
  }

  /** Process → 精简进程信息 / Process → compact process info */
  private toProcessInfo(process: {
    id: string;
    provider?: ProviderName;
    resolvedModel?: string;
    executor?: string;
    permissionMode?: string;
  }): WebhookPrivatePayload["process"] {
    return {
      id: process.id,
      provider: process.provider,
      model: process.resolvedModel,
      executor: process.executor,
      permissionMode: process.permissionMode,
    };
  }

  private decodeProjectPath(projectId: UrlProjectId): string | undefined {
    try {
      return decodeProjectId(projectId);
    } catch {
      return undefined;
    }
  }

  /**
   * 提取最后一条某角色的消息文本（拷贝自 LifecycleWebhookService）
   * Extract the last message text for a role (copied from LifecycleWebhookService)
   */
  private extractLastMessageText(
    history: Array<{
      type?: string;
      message?: { role?: string; content?: unknown };
    }>,
    role?: "user" | "assistant",
  ): string | undefined {
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (!entry) continue;

      const entryRole =
        entry.type === "user" || entry.type === "assistant"
          ? entry.type
          : entry.message?.role;
      if (role && entryRole !== role) {
        continue;
      }

      const content = entry.message?.content;
      const text = this.extractTextContent(content);
      if (text) {
        return text;
      }
    }

    return undefined;
  }

  private extractTextContent(content: unknown): string | undefined {
    if (typeof content === "string" && content.trim()) {
      return content.trim();
    }

    if (!Array.isArray(content)) {
      return undefined;
    }

    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        "text" in block &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        return block.text.trim();
      }
    }

    return undefined;
  }
}
