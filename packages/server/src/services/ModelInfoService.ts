/**
 * Centralized cache for model metadata (especially context window sizes).
 *
 * Providers fetch model info from various sources (Ollama /api/show, SDK probes, etc.)
 * but that data was previously stranded in getAvailableModels() calls. This service
 * caches it so readers and routes can look up context windows without re-fetching.
 *
 * Two layers, in resolution order:
 *  1. observed (durable) — real windows captured from an SDK `result` message's
 *     modelUsage (the only place the true, account-resolved window exists). Keyed
 *     by "<provider>:<model>" with the concrete model id, persisted to
 *     {dataDir}/model-context-windows.json so it survives server restarts. This is
 *     what fixes the "120% after restart" non-determinism (see
 *     topics/claude-1m-context.md).
 *  2. ingested (ephemeral) — provider-list/heuristic values from getAvailableModels()
 *     (warmProvider/ingestModels), keyed by alias (e.g. "opus", "opus[1m]"). NOT
 *     persisted: these are static guesses and would pollute the durable file.
 *
 * Sync getContextWindow() checks observed → ingested → shared heuristic. The
 * live-process value (Process.contextWindow) still overrides this at request time.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  CLAUDE_EXTENDED_CONTEXT_WINDOW,
  type ModelInfo,
  type ProviderName,
  getModelContextWindow,
} from "@yep-anywhere/shared";
import { getProvider } from "../sdk/providers/index.js";
import { createCoalescingSaver } from "../lib/coalescingSaver.js";

/** A real window observation captured from an SDK result message. */
export interface ObservedModelInfo {
  /** Context window size in tokens, as reported by the SDK. */
  contextWindow: number;
  /** ISO timestamp of when this window was last observed/confirmed. */
  observedAt: string;
}

interface ModelInfoState {
  /** "<provider>:<model>" → observed info */
  models: Record<string, ObservedModelInfo>;
  /** Schema version for future migrations */
  version: number;
}

const CURRENT_VERSION = 1;

export interface ModelInfoServiceOptions {
  /** Directory to persist observed model info (omit to run memory-only). */
  dataDir?: string;
}

export class ModelInfoService {
  /** Durable, real observations (persisted). */
  private observed = new Map<string, ObservedModelInfo>();
  /** Ephemeral provider-list/heuristic values (not persisted). */
  private ingested = new Map<string, number>();

  private filePath: string | undefined;
  private saver = createCoalescingSaver(() => this.doSave());

  constructor(options: ModelInfoServiceOptions = {}) {
    this.filePath = options.dataDir
      ? path.join(options.dataDir, "model-context-windows.json")
      : undefined;
  }

  /**
   * Load persisted observations from disk. Best-effort; missing/invalid files
   * start empty. No-op when constructed without a dataDir.
   */
  async initialize(): Promise<void> {
    if (!this.filePath) return;
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content) as ModelInfoState;
      if (parsed && typeof parsed === "object" && parsed.models) {
        for (const [key, info] of Object.entries(parsed.models)) {
          if (info && typeof info.contextWindow === "number") {
            this.observed.set(key, {
              contextWindow: info.contextWindow,
              observedAt: info.observedAt ?? new Date().toISOString(),
            });
          }
        }
        console.log(
          `[ModelInfoService] Loaded ${this.observed.size} observed model windows from disk`,
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          "[ModelInfoService] Failed to load state, starting fresh:",
          error,
        );
      }
    }
  }

  /**
   * Get context window for a model (sync).
   *
   * When the static heuristic confidently identifies a model as 1M (via [1m]
   * suffix, known model regexes, or explicit mapping), that answer takes
   * precedence over SDK observations. The Claude Code SDK defaults to 200K for
   * unrecognized models, which would incorrectly downgrade custom models routed
   * through ANTHROPIC_BASE_URL that actually have 1M windows.
   *
   * For non-1M models, the original precedence applies: durable observation →
   * ephemeral ingested → shared heuristic.
   */
  getContextWindow(model: string | undefined, provider?: ProviderName): number {
    // Short-circuit: if the heuristic says 1M, trust it. The SDK may report
    // 200K for unknown models, so observed values are not authoritative here.
    const heuristic = getModelContextWindow(model, provider);
    if (heuristic === CLAUDE_EXTENDED_CONTEXT_WINDOW) {
      return heuristic;
    }

    if (model && provider) {
      const key = `${provider}:${model}`;
      const obs = this.observed.get(key);
      if (obs !== undefined) return obs.contextWindow;
      const ingested = this.ingested.get(key);
      if (ingested !== undefined) return ingested;
    }
    return heuristic;
  }

  /**
   * Populate the ephemeral cache from a provider's getAvailableModels().
   * Call at startup and when sessions are created. Failures are logged, not thrown.
   */
  async warmProvider(providerName: ProviderName): Promise<void> {
    const provider = getProvider(providerName);
    if (!provider) return;

    try {
      const models = await provider.getAvailableModels();
      this.ingestModels(providerName, models);
    } catch {
      // Best-effort — fallback to heuristic
    }
  }

  /**
   * Ingest a model list into the ephemeral cache.
   * Called by warmProvider() and also by the providers route when it already
   * has fresh model data (avoids redundant fetches). These are provider-list
   * (often heuristic) values and are intentionally not persisted.
   */
  ingestModels(providerName: ProviderName, models: ModelInfo[]): void {
    for (const m of models) {
      if (m.contextWindow) {
        this.ingested.set(`${providerName}:${m.id}`, m.contextWindow);
      }
    }
  }

  /**
   * Record a context window discovered at runtime from a real SDK observation
   * (the contextWindow in a `result` message's modelUsage, or Codex
   * model_context_window). This is the durable layer: stored with a timestamp
   * and persisted so the window survives a server restart. Refreshes observedAt
   * on every observation, even when the value is unchanged.
   */
  recordContextWindow(
    model: string,
    contextWindow: number,
    provider?: ProviderName,
  ): void {
    const key = provider ? `${provider}:${model}` : model;
    this.observed.set(key, {
      contextWindow,
      observedAt: new Date().toISOString(),
    });
    // Flush on every observation so observedAt means "last confirmed". Callers
    // record at turn-completion cadence (not per request), and the debounced
    // writer coalesces any bursts, so this is cheap.
    void this.save();
  }

  /**
   * Await any in-flight/pending debounced write. Mainly for tests and graceful
   * shutdown; normal callers fire-and-forget via recordContextWindow.
   */
  async flush(): Promise<void> {
    await this.saver.idle();
  }

  /**
   * Save observed state to disk, coalescing concurrent requests.
   * No-op when constructed without a dataDir.
   */
  private save(): Promise<void> {
    if (!this.filePath) return Promise.resolve();
    return this.saver.save();
  }

  private async doSave(): Promise<void> {
    if (!this.filePath) return;
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const state: ModelInfoState = {
        version: CURRENT_VERSION,
        models: Object.fromEntries(this.observed),
      };
      await fs.writeFile(
        this.filePath,
        JSON.stringify(state, null, 2),
        "utf-8",
      );
    } catch (error) {
      console.error("[ModelInfoService] Failed to save state:", error);
    }
  }
}
