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
  /** Kind of provider turn currently producing usage observations. */
  activeTurnKind?: "human" | "automatic";
  /** Provider-input time for the next usage-bearing human turn. */
  humanTurnStartedAtMs?: number;
  /** Whether the first usage observation for that human turn was consumed. */
  humanTurnUsageObserved?: boolean;
  /** Total prompt size of the previous observation, for the growth measure. */
  lastTotalContextTokens?: number;
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

/**
 * Where each provider puts the token counts. Claude's Agent SDK yields
 * `SDKAssistantMessage`, whose usage lives on the nested API message
 * (`message.message.usage`) exactly as the transcript stores it. Codex reports
 * usage out of band, on a synthetic `system`/`token_usage` message whose usage
 * *is* top level. A monitor that assumes one shape sees neither provider.
 */
function findUsageFields(message: SDKMessage): UsageFields | undefined {
  const candidates: unknown[] = [
    (message as { usage?: unknown }).usage,
    (message as { message?: { usage?: unknown } }).message?.usage,
    (message as { modelUsage?: unknown }).modelUsage,
  ];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object") {
      return candidate as UsageFields;
    }
  }
  return undefined;
}

function carriesUsage(message: SDKMessage): boolean {
  if (message.type === "assistant") return true;
  return message.type === "system" && message.subtype === "token_usage";
}

/**
 * A boundary that rewrites the prompt prefix, so the next request pays for a
 * prefix the provider never cached and no earlier observation predicts it.
 * Microcompaction drops older content from the same prefix, which invalidates
 * the comparison exactly as a full compaction does.
 */
function isContextReplacementBoundary(message: SDKMessage): boolean {
  return (
    message.type === "system" &&
    (message.subtype === "compact_boundary" ||
      message.subtype === "microcompact_boundary")
  );
}

export function extractCacheMissBillingObservation(
  message: SDKMessage,
  provider: ProviderName,
): CacheMissBillingObservation | undefined {
  if (!carriesUsage(message)) {
    return undefined;
  }
  const rawUsage = findUsageFields(message);
  if (!rawUsage) {
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

  /**
   * The two providers count `input_tokens` differently, so normalize before
   * comparing anything. Codex follows the OpenAI convention where cached reads
   * are a *subset* of the reported input (verified against a rollout showing
   * `input_tokens: 109340, cached_input_tokens: 108288`). Claude reports the
   * three classes disjointly, so its prompt total is their sum.
   */
  const totalContextTokens =
    provider === "codex"
      ? Math.max(inputTokens, cacheReadTokens ?? 0)
      : inputTokens + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0);
  const uncachedInputTokens = Math.max(
    0,
    totalContextTokens - (cacheReadTokens ?? 0),
  );
  const outputTokens = numericField(rawUsage.output_tokens);

  if (totalContextTokens === 0) {
    return undefined;
  }

  return {
    messageId: messageId(message),
    usage: {
      inputTokens,
      ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
      ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      totalContextTokens,
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

  observeUserTurnStarted(process: Process, startedAtMs = Date.now()): void {
    this.observeProviderTurnStarted(process, "human", startedAtMs);
  }

  observeProviderTurnStarted(
    process: Process,
    turnKind: "human" | "automatic",
    startedAtMs = Date.now(),
  ): void {
    const state = this.processStates.get(process.id) ?? {
      messageIndex: 0,
      assistantUsageCount: 0,
    };
    state.activeTurnKind = turnKind;
    state.humanTurnStartedAtMs = turnKind === "human" ? startedAtMs : undefined;
    state.humanTurnUsageObserved = false;
    this.processStates.set(process.id, state);
  }

  observeMessage(process: Process, message: SDKMessage): void {
    const state = this.processStates.get(process.id) ?? {
      messageIndex: 0,
      assistantUsageCount: 0,
    };
    state.messageIndex += 1;
    this.processStates.set(process.id, state);

    if (isContextReplacementBoundary(message)) {
      state.lastExpectedWarmAtMs = undefined;
      state.lastTotalContextTokens = undefined;
      return;
    }

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
    const previousTotalContextTokens = state.lastTotalContextTokens;
    const humanTurnStartedAtMs = state.humanTurnStartedAtMs;
    const firstUsageForHumanTurn =
      humanTurnStartedAtMs !== undefined &&
      state.humanTurnUsageObserved !== true;
    state.assistantUsageCount += 1;
    state.lastExpectedWarmAtMs = nowMs;
    state.lastTotalContextTokens = observation.usage.totalContextTokens;
    if (humanTurnStartedAtMs !== undefined) {
      state.humanTurnUsageObserved = true;
    }

    // Automatic provider turns still advance the warm-prefix baseline, but
    // they are never evidence about a human turn and must never raise popups.
    if (state.activeTurnKind !== "human") {
      return;
    }

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
    const cacheRequestStartedAtMs = humanTurnStartedAtMs ?? nowMs;
    const elapsedSinceWarmObservationMs =
      lastWarmAtMs > 0
        ? Math.max(0, cacheRequestStartedAtMs - lastWarmAtMs)
        : undefined;
    const elapsedSinceExpectedCacheMs =
      humanTurnStartedAtMs !== undefined && lastWarmAtMs > 0
        ? firstUsageForHumanTurn
          ? Math.max(0, humanTurnStartedAtMs - lastWarmAtMs)
          : 0
        : undefined;
    const warmExpected =
      elapsedSinceWarmObservationMs !== undefined &&
      elapsedSinceWarmObservationMs <= providerFreshWindowMinutes * 60_000;
    const expectedCacheExpired =
      !forkExpected &&
      elapsedSinceWarmObservationMs !== undefined &&
      !warmExpected;

    if (!forkExpected && !warmExpected && !expectedCacheExpired) {
      return;
    }
    const ignoreAfterMinutes = settings.ignoreAfterMinutes;
    if (
      ignoreAfterMinutes > 0 &&
      elapsedSinceExpectedCacheMs !== undefined &&
      elapsedSinceExpectedCacheMs > ignoreAfterMinutes * 60_000
    ) {
      return;
    }
    const expectedCacheSource = forkExpected ? "fork" : "warm-session";

    /**
     * A continuing turn is expected to pay for whatever was appended since the
     * cached prefix — the user's message plus the previous assistant turn and
     * its tool results. Total prompt growth measures that directly, in the
     * provider's own tokens, with no tokenizer of our own. A fork's first turn
     * appends nothing, so its expectation is zero; session boot has no
     * previous turn to measure, so it has no expectation at all and can never
     * be flagged.
     */
    const expectedNewContentTokens = forkExpected
      ? 0
      : previousTotalContextTokens === undefined
        ? undefined
        : Math.max(
            0,
            observation.usage.totalContextTokens - previousTotalContextTokens,
          );
    const wastedInputTokens =
      expectedNewContentTokens === undefined
        ? 0
        : Math.max(
            0,
            observation.usage.uncachedInputTokens - expectedNewContentTokens,
          );

    const expectedInputCost: ExpectedInputCostState = {
      state: forkExpected ? "expected-free" : "expected-new-content",
      ...(expectedNewContentTokens !== undefined
        ? { expectedUncachedPrefixTokens: expectedNewContentTokens }
        : {}),
      source: expectedCacheSource,
      prefixBasis: forkExpected
        ? "provider-fork-byte-identical"
        : "same-session-prefix",
      freshEnough: !expectedCacheExpired,
      providerFreshWindowMinutes,
    };

    const missed =
      expectedNewContentTokens !== undefined &&
      wastedInputTokens >= settings.minimumWastedTokens;
    const outcome: CacheMissBillingOutcome | null = missed
      ? expectedCacheExpired
        ? "expected-cache-expiry"
        : "unexpected-recompute"
      : this.shouldRecordHit(observation, elapsedSinceExpectedCacheMs)
        ? "expected-cache-hit"
        : null;
    if (!outcome) {
      return;
    }
    const withinRecentActivity =
      elapsedSinceExpectedCacheMs !== undefined &&
      elapsedSinceExpectedCacheMs <= settings.recentActivityMinutes * 60_000;
    const exception =
      outcome === "unexpected-recompute" && !withinRecentActivity;

    const record: CacheMissBillingRecord = {
      id: randomUUID(),
      timestamp: nowIso,
      provider: process.provider,
      ...(process.resolvedModel ? { model: process.resolvedModel } : {}),
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
          : outcome === "expected-cache-expiry"
            ? "warm-session-cache-expiry"
            : "warm-session-cache-miss",
      outcome,
      exception,
      ...(observation.messageId ? { messageId: observation.messageId } : {}),
      messageIndex: state.messageIndex,
      observedUsage: observation.usage,
      expectedInputCost,
      wastedInputTokens,
      freshWindowMinutes: providerFreshWindowMinutes,
      ...(elapsedSinceExpectedCacheMs !== undefined
        ? { elapsedSinceExpectedCacheMs }
        : {}),
      expectedCacheSource,
      ...(firstUsageForHumanTurn && elapsedSinceExpectedCacheMs !== undefined
        ? { completeProbabilitySample: true }
        : {}),
    };

    void this.record(record, settings.showToasts && exception);
  }

  /** Clean hits are the denominator required for an empirical miss rate. */
  private shouldRecordHit(
    observation: CacheMissBillingObservation,
    elapsedSinceExpectedCacheMs: number | undefined,
  ): boolean {
    if ((observation.usage.cacheReadTokens ?? 0) <= 0) return false;
    return elapsedSinceExpectedCacheMs !== undefined;
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
        type: record.expectedInputCost.freshEnough
          ? "cache-miss-billing"
          : "cache-miss-billing-expected-expiry",
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
