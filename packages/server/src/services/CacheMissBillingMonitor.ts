import { randomUUID } from "node:crypto";
import {
  DEFAULT_CACHE_MISS_BILLING_SETTINGS,
  type CacheMissBillingOutcome,
  type CacheMissBillingRecord,
  type CacheMissBillingSettings,
  type CacheMissBillingUsage,
  type ExpectedInputCostState,
  type ProviderName,
} from "@yep-anywhere/shared";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/index.js";
import type { SDKMessage } from "../sdk/types.js";
import type { Process } from "../supervisor/Process.js";
import type { EventBus } from "../watcher/EventBus.js";

const CACHE_MISS_BILLING_PROVIDERS = new Set<ProviderName>(["claude", "codex"]);

interface ProcessUsageState {
  messageIndex: number;
  assistantUsageCount: number;
  lastExpectedWarmAtMs?: number;
}

type UsageFields = {
  input_tokens?: unknown;
  cached_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  output_tokens?: unknown;
};

export interface CacheMissBillingObservation {
  usage: CacheMissBillingUsage;
  messageId?: string;
}

export function normalizeCacheMissBillingSettings(
  settings: CacheMissBillingSettings | undefined,
): Required<CacheMissBillingSettings> {
  return {
    ...DEFAULT_CACHE_MISS_BILLING_SETTINGS,
    ...settings,
    providerFreshWindowMinutes: {
      ...DEFAULT_CACHE_MISS_BILLING_SETTINGS.providerFreshWindowMinutes,
      ...settings?.providerFreshWindowMinutes,
    },
  };
}

export function getCacheMissBillingFreshWindowMinutes(
  settings: Required<CacheMissBillingSettings>,
  provider: ProviderName,
): number {
  return (
    settings.providerFreshWindowMinutes[provider] ?? settings.freshWindowMinutes
  );
}

function numericField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : undefined;
}

function messageId(message: SDKMessage): string | undefined {
  const candidate = (message as { uuid?: unknown; id?: unknown }).uuid;
  if (typeof candidate === "string" && candidate.trim()) {
    return candidate;
  }
  const alternate = (message as { id?: unknown }).id;
  return typeof alternate === "string" && alternate.trim()
    ? alternate
    : undefined;
}

export function extractCacheMissBillingObservation(
  message: SDKMessage,
  provider: ProviderName,
): CacheMissBillingObservation | undefined {
  if (message.type !== "assistant") {
    return undefined;
  }
  const rawUsage = (message as { usage?: UsageFields }).usage;
  if (!rawUsage || typeof rawUsage !== "object") {
    return undefined;
  }

  const inputTokens = numericField(rawUsage.input_tokens) ?? 0;
  const cacheReadTokens =
    provider === "codex"
      ? numericField(rawUsage.cached_input_tokens)
      : (numericField(rawUsage.cache_read_input_tokens) ??
        numericField(rawUsage.cached_input_tokens));
  const cacheCreationTokens = numericField(
    rawUsage.cache_creation_input_tokens,
  );
  const outputTokens = numericField(rawUsage.output_tokens);
  const uncachedInputTokens = inputTokens + (cacheCreationTokens ?? 0);

  if (inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0) === 0) {
    return undefined;
  }

  return {
    messageId: messageId(message),
    usage: {
      inputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      uncachedInputTokens,
    },
  };
}

export class CacheMissBillingMonitor {
  private readonly processStates = new Map<string, ProcessUsageState>();

  constructor(
    private readonly options: {
      eventBus?: EventBus;
      sessionMetadataService?: SessionMetadataService;
      getSettings?: () => CacheMissBillingSettings | undefined;
    },
  ) {}

  forgetProcess(processId: string): void {
    this.processStates.delete(processId);
  }

  observeMessage(process: Process, message: SDKMessage): void {
    const state = this.processStates.get(process.id) ?? {
      messageIndex: 0,
      assistantUsageCount: 0,
    };
    state.messageIndex += 1;
    this.processStates.set(process.id, state);

    if (!CACHE_MISS_BILLING_PROVIDERS.has(process.provider)) {
      return;
    }

    const observation = extractCacheMissBillingObservation(
      message,
      process.provider,
    );
    if (!observation) {
      return;
    }

    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const assistantUsageCountBefore = state.assistantUsageCount;
    const previousWarmAtMs = state.lastExpectedWarmAtMs;
    state.assistantUsageCount += 1;
    state.lastExpectedWarmAtMs = nowMs;

    const settings = normalizeCacheMissBillingSettings(
      this.options.getSettings?.(),
    );
    if (!settings.enabled) {
      return;
    }

    const metadata = this.options.sessionMetadataService?.getMetadata(
      process.sessionId,
    );
    const forkedFromSessionId =
      metadata?.forkedFromSessionId ?? metadata?.parentSessionId;
    const forkExpected =
      assistantUsageCountBefore === 0 && !!forkedFromSessionId;
    const providerFreshWindowMinutes = getCacheMissBillingFreshWindowMinutes(
      settings,
      process.provider,
    );
    const lastWarmAtMs = Math.max(
      previousWarmAtMs ?? 0,
      process.lastPromptCacheRefreshTime?.getTime() ?? 0,
    );
    const elapsedSinceExpectedCacheMs =
      lastWarmAtMs > 0 ? nowMs - lastWarmAtMs : undefined;
    const warmExpected =
      elapsedSinceExpectedCacheMs !== undefined &&
      elapsedSinceExpectedCacheMs <= providerFreshWindowMinutes * 60_000;

    if (!forkExpected && !warmExpected) {
      return;
    }
    const expectedCacheSource = forkExpected ? "fork" : "warm-session";
    const expectedInputCost: ExpectedInputCostState = {
      state: "expected-free",
      expectedUncachedPrefixTokens: 0,
      source: expectedCacheSource,
      prefixByteIdentical: true,
      prefixBasis: forkExpected
        ? "provider-fork-byte-identical"
        : "same-session-prefix",
      freshEnough: true,
      providerFreshWindowMinutes,
    };
    const cacheReadTokens = observation.usage.cacheReadTokens ?? 0;
    const uncachedInputTokens = observation.usage.uncachedInputTokens;
    const outcome: CacheMissBillingOutcome | null =
      cacheReadTokens > 0 && uncachedInputTokens < settings.minimumInputTokens
        ? "expected-cache-hit"
        : cacheReadTokens === 0 &&
            uncachedInputTokens >= settings.minimumInputTokens
          ? "unexpected-recompute"
          : null;
    if (!outcome) {
      return;
    }

    const record: CacheMissBillingRecord = {
      id: randomUUID(),
      timestamp: nowIso,
      provider: process.provider,
      sessionId: process.sessionId,
      projectId: process.projectId,
      sessionPath: `/projects/${process.projectId}/sessions/${process.sessionId}`,
      ...(metadata?.parentSessionId
        ? { parentSessionId: metadata.parentSessionId }
        : {}),
      ...(metadata?.forkedFromSessionId
        ? { forkedFromSessionId: metadata.forkedFromSessionId }
        : {}),
      reason: forkExpected
        ? outcome === "expected-cache-hit"
          ? "fork-prefix-cache-hit"
          : "fork-prefix-cache-miss"
        : outcome === "expected-cache-hit"
          ? "warm-session-cache-hit"
          : "warm-session-cache-miss",
      outcome,
      ...(observation.messageId ? { messageId: observation.messageId } : {}),
      messageIndex: state.messageIndex,
      observedUsage: observation.usage,
      expectedInputCost,
      freshWindowMinutes: providerFreshWindowMinutes,
      ...(elapsedSinceExpectedCacheMs !== undefined
        ? { elapsedSinceExpectedCacheMs }
        : {}),
      expectedCacheSource,
    };

    void this.record(
      record,
      settings.showToasts && outcome === "unexpected-recompute",
    );
  }

  private async record(
    record: CacheMissBillingRecord,
    showToast: boolean,
  ): Promise<void> {
    try {
      await this.options.sessionMetadataService?.addCacheMissBillingEvent(
        record.sessionId,
        record,
      );
      this.options.eventBus?.emit({
        type: "cache-miss-billing",
        record,
        showToast,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      getLogger().warn(
        {
          event: "cache_miss_billing_record_failed",
          sessionId: record.sessionId,
          provider: record.provider,
          error: error instanceof Error ? error.message : String(error),
        },
        "Failed to record cache-billing usage evidence",
      );
    }
  }
}
