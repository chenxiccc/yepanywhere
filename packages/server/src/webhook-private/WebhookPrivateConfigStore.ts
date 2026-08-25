/**
 * webhook-private 配置存储 / webhook-private config store
 *
 * 读写独立文件 webhook-private.json，采用与 PushService 一致的原子写入
 * （先写 .tmp 再 rename）+ 防抖保存，避免多实例并发写入损坏。
 * Reads/writes the standalone webhook-private.json file, using the same
 * atomic write (write .tmp then rename) + debounced save as PushService to
 * avoid corruption from concurrent writes across instances.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  DEFAULT_WEBHOOK_PRIVATE_CONFIG,
  WEBHOOK_PRIVATE_CONFIG_VERSION,
  type WebhookPrivateConfig,
  type WebhookPlatform,
} from "./types.js";

export interface WebhookPrivateConfigStoreOptions {
  /** 数据目录，默认 ~/.yep-anywhere / Data dir, defaults to ~/.yep-anywhere */
  dataDir?: string;
}

const VALID_PLATFORMS = new Set<WebhookPlatform>(["auto", "dingtalk", "feishu"]);

export class WebhookPrivateConfigStore {
  private readonly dataDir: string;
  private readonly filePath: string;
  private state: WebhookPrivateConfig;
  private initialized = false;
  // 防抖保存：与 PushService 一致的两段式实现 / Debounced save, same shape as PushService
  private savePromise: Promise<void> | null = null;
  private pendingSave = false;

  constructor(options: WebhookPrivateConfigStoreOptions = {}) {
    this.dataDir =
      options.dataDir ??
      path.join(
        process.env.HOME ?? process.env.USERPROFILE ?? ".",
        ".yep-anywhere",
      );
    this.filePath = path.join(this.dataDir, "webhook-private.json");
    // 起步状态用默认值，initialize() 会从盘上覆盖 / Start from defaults; initialize() overrides from disk
    this.state = { ...DEFAULT_WEBHOOK_PRIVATE_CONFIG };
  }

  /**
   * 从盘加载配置 / Load config from disk
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.dataDir, { recursive: true });
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as Partial<WebhookPrivateConfig>;
      this.state = this.mergeWithDefaults(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 文件存在但解析失败时告警，并回退默认值
        // Warn on parse failure (file exists but invalid), fall back to defaults
        console.warn(
          "[WebhookPrivate] Failed to load config, starting fresh:",
          error,
        );
      }
      this.state = { ...DEFAULT_WEBHOOK_PRIVATE_CONFIG };
    }

    this.initialized = true;
  }

  /** 仅供测试：确认是否已初始化 / Test-only: whether initialized */
  isInitialized(): boolean {
    return this.initialized;
  }

  /** 仅供测试：返回文件路径 / Test-only: file path */
  getFilePath(): string {
    return this.filePath;
  }

  /**
   * 取当前配置（不可变副本）/ Get current config (immutable copy)
   */
  get(): WebhookPrivateConfig {
    this.ensureInitialized();
    return { ...this.state, events: { ...this.state.events } };
  }

  /**
   * 用 patch 更新配置并持久化 / Apply a patch and persist
   *
   * 只接受白名单字段，其余忽略；返回更新后的配置。
   * Only whitelisted fields are accepted; returns the updated config.
   */
  async update(
    patch: Partial<WebhookPrivateConfig>,
  ): Promise<WebhookPrivateConfig> {
    this.ensureInitialized();
    const next: WebhookPrivateConfig = {
      ...this.state,
      ...this.normalizePatch(patch),
    };
    this.state = next;
    await this.save();
    return this.get();
  }

  /** 直接替换内部状态（仅供测试）/ Replace internal state directly (test-only) */
  _setStateForTest(state: WebhookPrivateConfig): void {
    this.state = { ...state, events: { ...state.events } };
    this.initialized = true;
  }

  private ensureInitialized(): void {
    if (!this.initialized) {
      throw new Error(
        "WebhookPrivateConfigStore not initialized. Call initialize() first.",
      );
    }
  }

  /**
   * 把盘上读到的部分对象与默认值合并 / Merge a partial on-disk object with defaults
   */
  private mergeWithDefaults(
    parsed: Partial<WebhookPrivateConfig>,
  ): WebhookPrivateConfig {
    const events = {
      ...DEFAULT_WEBHOOK_PRIVATE_CONFIG.events,
      ...(parsed.events ?? {}),
    };
    return {
      version: WEBHOOK_PRIVATE_CONFIG_VERSION,
      enabled:
        typeof parsed.enabled === "boolean"
          ? parsed.enabled
          : DEFAULT_WEBHOOK_PRIVATE_CONFIG.enabled,
      url: typeof parsed.url === "string" ? parsed.url : "",
      secret: typeof parsed.secret === "string" ? parsed.secret : "",
      platform: VALID_PLATFORMS.has(parsed.platform as WebhookPlatform)
        ? (parsed.platform as WebhookPlatform)
        : DEFAULT_WEBHOOK_PRIVATE_CONFIG.platform,
      events: {
        idle: typeof events.idle === "boolean" ? events.idle : true,
        error: typeof events.error === "boolean" ? events.error : true,
        toolApproval:
          typeof events.toolApproval === "boolean" ? events.toolApproval : true,
        userQuestion:
          typeof events.userQuestion === "boolean"
            ? events.userQuestion
            : true,
      },
      dryRun:
        typeof parsed.dryRun === "boolean"
          ? parsed.dryRun
          : DEFAULT_WEBHOOK_PRIVATE_CONFIG.dryRun,
    };
  }

  /**
   * 从 patch 提取白名单字段并校验 / Extract & validate whitelisted fields from a patch
   */
  private normalizePatch(
    patch: Partial<WebhookPrivateConfig>,
  ): Partial<WebhookPrivateConfig> {
    const out: Partial<WebhookPrivateConfig> = {};
    if (typeof patch.enabled === "boolean") out.enabled = patch.enabled;
    if (typeof patch.url === "string") out.url = patch.url;
    if (typeof patch.secret === "string") out.secret = patch.secret;
    if (
      typeof patch.platform === "string" &&
      VALID_PLATFORMS.has(patch.platform as WebhookPlatform)
    ) {
      out.platform = patch.platform as WebhookPlatform;
    }
    if (typeof patch.dryRun === "boolean") out.dryRun = patch.dryRun;
    if (patch.events && typeof patch.events === "object") {
      const ev = { ...this.state.events };
      if (typeof patch.events.idle === "boolean") ev.idle = patch.events.idle;
      if (typeof patch.events.error === "boolean")
        ev.error = patch.events.error;
      if (typeof patch.events.toolApproval === "boolean")
        ev.toolApproval = patch.events.toolApproval;
      if (typeof patch.events.userQuestion === "boolean")
        ev.userQuestion = patch.events.userQuestion;
      out.events = ev;
    }
    return out;
  }

  /**
   * 防抖保存 / Debounced save
   */
  private async save(): Promise<void> {
    if (this.savePromise) {
      this.pendingSave = true;
      return;
    }
    this.savePromise = this.doSave();
    await this.savePromise;
    this.savePromise = null;
    if (this.pendingSave) {
      this.pendingSave = false;
      await this.save();
    }
  }

  /**
   * 原子写入：先写 .tmp 再 rename / Atomic write: write .tmp then rename
   */
  private async doSave(): Promise<void> {
    try {
      const content = JSON.stringify(this.state, null, 2);
      const tmpPath = `${this.filePath}.tmp`;
      await fs.writeFile(tmpPath, content, "utf-8");
      await fs.rename(tmpPath, this.filePath);
    } catch (error) {
      console.error("[WebhookPrivate] Failed to save config:", error);
      throw error;
    }
  }
}
