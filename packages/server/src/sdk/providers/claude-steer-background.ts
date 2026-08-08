import {
  createClaudeSteerBackgroundBashMatcher,
  type ClaudeSteerBackgroundBashSettings,
} from "@yep-anywhere/shared";
import type { SDKMessage } from "../types.js";

const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 13;

interface ForegroundBash {
  command: string;
}

interface ClaudeSteerBackgroundControllerOptions {
  settings: ClaudeSteerBackgroundBashSettings;
  backgroundTask: (toolUseId: string) => Promise<boolean>;
  signal?: AbortSignal;
  retryDelay?: () => Promise<void>;
  maxAttempts?: number;
}

function waitForRetry(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timeout = setTimeout(finish, DEFAULT_RETRY_DELAY_MS);
    timeout.unref?.();

    function finish(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", finish);
      resolve();
    }

    signal?.addEventListener("abort", finish, { once: true });
  });
}

function messageContent(message: SDKMessage) {
  return Array.isArray(message.message?.content) ? message.message.content : [];
}

/**
 * Tracks only blocking Bash tool calls visible in the main Claude stream.
 * A successful targeted background request removes the call immediately;
 * its synthetic tool_result will later confirm the same transition.
 */
export class ClaudeSteerBackgroundController {
  private readonly foregroundBash = new Map<string, ForegroundBash>();
  private readonly backgroundInFlight = new Map<string, Promise<void>>();
  private readonly matchesCommand: (command: string) => boolean;
  private readonly backgroundTask: (toolUseId: string) => Promise<boolean>;
  private readonly signal?: AbortSignal;
  private readonly retryDelay: () => Promise<void>;
  private readonly maxAttempts: number;

  constructor(options: ClaudeSteerBackgroundControllerOptions) {
    this.matchesCommand = createClaudeSteerBackgroundBashMatcher(
      options.settings,
    );
    this.backgroundTask = options.backgroundTask;
    this.signal = options.signal;
    this.retryDelay = options.retryDelay ?? (() => waitForRetry(this.signal));
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  }

  observe(message: SDKMessage): void {
    if (message.parent_tool_use_id) return;

    if (message.type === "assistant") {
      for (const block of messageContent(message)) {
        const input =
          block.input !== null && typeof block.input === "object"
            ? (block.input as Record<string, unknown>)
            : null;
        const command = input?.command;
        if (
          block.type === "tool_use" &&
          block.name === "Bash" &&
          typeof block.id === "string" &&
          typeof command === "string" &&
          input?.run_in_background !== true
        ) {
          this.foregroundBash.set(block.id, {
            command,
          });
        }
      }
      return;
    }

    if (message.type === "user") {
      for (const block of messageContent(message)) {
        if (
          block.type === "tool_result" &&
          typeof block.tool_use_id === "string"
        ) {
          this.foregroundBash.delete(block.tool_use_id);
        }
      }
    }
  }

  async backgroundEligible(): Promise<void> {
    const eligibleIds = [...this.foregroundBash.entries()]
      .filter(([, bash]) => this.matchesCommand(bash.command))
      .map(([toolUseId]) => toolUseId);
    await Promise.all(
      eligibleIds.map((toolUseId) => this.background(toolUseId)),
    );
  }

  private background(toolUseId: string): Promise<void> {
    const current = this.backgroundInFlight.get(toolUseId);
    if (current) return current;

    const attempt = this.attemptBackground(toolUseId).finally(() => {
      this.backgroundInFlight.delete(toolUseId);
    });
    this.backgroundInFlight.set(toolUseId, attempt);
    return attempt;
  }

  private async attemptBackground(toolUseId: string): Promise<void> {
    for (let attempt = 0; attempt < this.maxAttempts; attempt += 1) {
      if (this.signal?.aborted || !this.foregroundBash.has(toolUseId)) {
        return;
      }
      if (await this.backgroundTask(toolUseId)) {
        this.foregroundBash.delete(toolUseId);
        return;
      }
      if (attempt + 1 < this.maxAttempts) {
        await this.retryDelay();
      }
    }
  }
}
