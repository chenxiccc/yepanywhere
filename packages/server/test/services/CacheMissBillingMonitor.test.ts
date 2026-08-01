import type { UrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionMetadataService } from "../../src/metadata/index.js";
import type { SDKMessage } from "../../src/sdk/types.js";
import {
  CacheMissBillingMonitor,
  extractCacheMissBillingObservation,
  getCacheMissBillingFreshWindowMinutes,
  normalizeCacheMissBillingSettings,
} from "../../src/services/CacheMissBillingMonitor.js";
import type { Process } from "../../src/supervisor/Process.js";
import type { EventBus } from "../../src/watcher/EventBus.js";

async function waitFor(assertion: () => void): Promise<void> {
  const timeoutAt = Date.now() + 1000;
  while (Date.now() < timeoutAt) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  assertion();
}

function fakeProcess(
  overrides: Partial<Process> & {
    provider?: Process["provider"];
    lastPromptCacheRefreshTime?: Date | null;
  } = {},
): Process {
  return {
    id: "process-1",
    provider: "claude",
    sessionId: "session-1",
    projectId: "project-1" as UrlProjectId,
    lastPromptCacheRefreshTime: null,
    ...overrides,
  } as Process;
}

function assistantMessage(usage: Record<string, number>): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-1",
    message: { role: "assistant", content: [] },
    usage,
  } as SDKMessage;
}

describe("CacheMissBillingMonitor", () => {
  it("normalizes default-off settings with popup enabled when opted in", () => {
    expect(normalizeCacheMissBillingSettings(undefined)).toMatchObject({
      enabled: false,
      showToasts: true,
      freshWindowMinutes: 60,
      providerFreshWindowMinutes: {
        claude: 60,
        codex: 10,
      },
      minimumInputTokens: 50_000,
    });
  });

  it("uses provider-specific expected-free freshness windows", () => {
    const normalized = normalizeCacheMissBillingSettings(undefined);

    expect(getCacheMissBillingFreshWindowMinutes(normalized, "claude")).toBe(
      60,
    );
    expect(getCacheMissBillingFreshWindowMinutes(normalized, "codex")).toBe(10);
    expect(getCacheMissBillingFreshWindowMinutes(normalized, "gemini")).toBe(
      60,
    );
  });

  it("extracts Claude uncached input from cache creation usage", () => {
    const observation = extractCacheMissBillingObservation(
      assistantMessage({
        input_tokens: 10,
        cache_creation_input_tokens: 900_000,
        cache_read_input_tokens: 0,
      }),
      "claude",
    );

    expect(observation?.usage).toMatchObject({
      inputTokens: 10,
      cacheCreationTokens: 900_000,
      cacheReadTokens: 0,
      uncachedInputTokens: 900_010,
    });
  });

  it("extracts Codex cached input as cache-read usage", () => {
    const observation = extractCacheMissBillingObservation(
      assistantMessage({
        input_tokens: 12,
        cached_input_tokens: 345,
      }),
      "codex",
    );

    expect(observation?.usage).toMatchObject({
      inputTokens: 12,
      cacheReadTokens: 345,
      uncachedInputTokens: 12,
    });
  });

  it("records a first fork turn when cached-read tokens are zero", async () => {
    const addCacheMissBillingEvent = vi.fn(async () => {});
    const emit = vi.fn();
    const monitor = new CacheMissBillingMonitor({
      getSettings: () => ({
        enabled: true,
        showToasts: true,
        minimumInputTokens: 100,
        freshWindowMinutes: 60,
      }),
      sessionMetadataService: {
        getMetadata: () => ({ forkedFromSessionId: "parent-1" }),
        addCacheMissBillingEvent,
      } as unknown as SessionMetadataService,
      eventBus: { emit } as unknown as EventBus,
    });

    monitor.observeMessage(
      fakeProcess(),
      assistantMessage({
        input_tokens: 150_000,
        cache_read_input_tokens: 0,
      }),
    );

    await waitFor(() => expect(addCacheMissBillingEvent).toHaveBeenCalled());
    const [, record] = addCacheMissBillingEvent.mock.calls[0]!;
    expect(record).toMatchObject({
      provider: "claude",
      sessionId: "session-1",
      forkedFromSessionId: "parent-1",
      reason: "fork-prefix-cache-miss",
      outcome: "unexpected-recompute",
      messageId: "assistant-1",
      expectedCacheSource: "fork",
      expectedInputCost: {
        state: "expected-free",
        expectedUncachedPrefixTokens: 0,
        source: "fork",
        prefixByteIdentical: true,
        prefixBasis: "provider-fork-byte-identical",
        freshEnough: true,
        providerFreshWindowMinutes: 60,
      },
      observedUsage: {
        inputTokens: 150_000,
        cacheReadTokens: 0,
        uncachedInputTokens: 150_000,
      },
    });
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      type: "cache-miss-billing",
      showToast: true,
    });
  });

  it("records a fork cache hit without a popup", async () => {
    const addCacheMissBillingEvent = vi.fn(async () => {});
    const emit = vi.fn();
    const monitor = new CacheMissBillingMonitor({
      getSettings: () => ({
        enabled: true,
        showToasts: true,
        minimumInputTokens: 100,
      }),
      sessionMetadataService: {
        getMetadata: () => ({ parentSessionId: "parent-1" }),
        addCacheMissBillingEvent,
      } as unknown as SessionMetadataService,
      eventBus: { emit } as unknown as EventBus,
    });

    monitor.observeMessage(
      fakeProcess(),
      assistantMessage({
        input_tokens: 50,
        cache_read_input_tokens: 150_000,
      }),
    );

    await waitFor(() => expect(addCacheMissBillingEvent).toHaveBeenCalled());
    const [, record] = addCacheMissBillingEvent.mock.calls[0]!;
    expect(record).toMatchObject({
      reason: "fork-prefix-cache-hit",
      outcome: "expected-cache-hit",
      observedUsage: {
        inputTokens: 50,
        cacheReadTokens: 150_000,
        uncachedInputTokens: 50,
      },
    });
    expect(emit.mock.calls[0]?.[0]).toMatchObject({
      type: "cache-miss-billing",
      showToast: false,
    });
  });

  it("records a recent warm Claude session recompute as unexpected", async () => {
    const addCacheMissBillingEvent = vi.fn(async () => {});
    const monitor = new CacheMissBillingMonitor({
      getSettings: () => ({
        enabled: true,
        minimumInputTokens: 100,
      }),
      sessionMetadataService: {
        getMetadata: () => ({}),
        addCacheMissBillingEvent,
      } as unknown as SessionMetadataService,
    });

    monitor.observeMessage(
      fakeProcess({
        lastPromptCacheRefreshTime: new Date(Date.now() - 30 * 60_000),
      }),
      assistantMessage({
        input_tokens: 150_000,
        cache_read_input_tokens: 0,
      }),
    );

    await waitFor(() => expect(addCacheMissBillingEvent).toHaveBeenCalled());
    const [, record] = addCacheMissBillingEvent.mock.calls[0]!;
    expect(record).toMatchObject({
      reason: "warm-session-cache-miss",
      outcome: "unexpected-recompute",
      expectedCacheSource: "warm-session",
      expectedInputCost: {
        source: "warm-session",
        prefixBasis: "same-session-prefix",
        providerFreshWindowMinutes: 60,
      },
    });
  });
});
