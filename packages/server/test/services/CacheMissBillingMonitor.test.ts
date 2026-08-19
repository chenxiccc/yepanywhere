import type {
  CacheMissBillingRecord,
  UrlProjectId,
} from "@yep-anywhere/shared";
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

/**
 * Shaped like a real `SDKAssistantMessage`: the Agent SDK carries usage on the
 * nested API message, never at the top level. A fixture that flattens it hides
 * exactly the defect this suite exists to catch.
 */
function claudeAssistantMessage(usage: Record<string, number>): SDKMessage {
  return {
    type: "assistant",
    uuid: "assistant-1",
    session_id: "session-1",
    parent_tool_use_id: null,
    message: { role: "assistant", content: [], usage },
  } as unknown as SDKMessage;
}

/** Shaped like the synthetic message Codex emits for `thread/tokenUsage`. */
function codexTokenUsageMessage(usage: Record<string, number>): SDKMessage {
  return {
    type: "system",
    subtype: "token_usage",
    session_id: "session-1",
    isSynthetic: true,
    usage,
  } as unknown as SDKMessage;
}

function compactBoundaryMessage(
  subtype: "compact_boundary" | "microcompact_boundary" = "compact_boundary",
): SDKMessage {
  return {
    type: "system",
    subtype,
    session_id: "session-1",
  } as unknown as SDKMessage;
}

function monitorWith(
  settings: Record<string, unknown>,
  metadata: Record<string, unknown> = {},
) {
  const addCacheMissBillingEvent = vi.fn(
    async (_sessionId: string, _record: CacheMissBillingRecord) => {},
  );
  const emit = vi.fn();
  const monitor = new CacheMissBillingMonitor({
    getSettings: () => settings,
    sessionMetadataService: {
      getMetadata: () => metadata,
      addCacheMissBillingEvent,
    } as unknown as SessionMetadataService,
    eventBus: { emit } as unknown as EventBus,
  });
  return { monitor, addCacheMissBillingEvent, emit };
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
      minimumWastedTokens: 10_000,
      recentActivityMinutes: 10,
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

  it("reads Claude usage from the nested SDK message", () => {
    const observation = extractCacheMissBillingObservation(
      claudeAssistantMessage({
        input_tokens: 2,
        cache_creation_input_tokens: 2324,
        cache_read_input_tokens: 78_673,
        output_tokens: 604,
      }),
      "claude",
    );

    expect(observation?.usage).toMatchObject({
      inputTokens: 2,
      cacheCreationTokens: 2324,
      cacheReadTokens: 78_673,
      outputTokens: 604,
      // Claude counts the three classes disjointly.
      totalContextTokens: 80_999,
      uncachedInputTokens: 2326,
    });
  });

  it("reads Codex usage from its token_usage system message", () => {
    // Real rollout numbers: cached input is a subset of input_tokens.
    const observation = extractCacheMissBillingObservation(
      codexTokenUsageMessage({
        input_tokens: 109_340,
        cached_input_tokens: 108_288,
        output_tokens: 795,
      }),
      "codex",
    );

    expect(observation?.usage).toMatchObject({
      inputTokens: 109_340,
      cacheReadTokens: 108_288,
      totalContextTokens: 109_340,
      uncachedInputTokens: 1052,
    });
  });

  it("ignores an assistant message with no usage anywhere", () => {
    expect(
      extractCacheMissBillingObservation(
        {
          type: "assistant",
          message: { role: "assistant", content: [] },
        } as unknown as SDKMessage,
        "claude",
      ),
    ).toBeUndefined();
  });

  it("does not fault a warm turn for the content it appended", async () => {
    const { monitor, addCacheMissBillingEvent } = monitorWith({
      enabled: true,
      minimumWastedTokens: 10_000,
    });
    const process = fakeProcess();

    // First turn establishes the prefix size; second appends 60k of new
    // content and pays for it as cache writes — expected, not a miss.
    monitor.observeMessage(
      process,
      claudeAssistantMessage({
        input_tokens: 5,
        cache_read_input_tokens: 100_000,
        cache_creation_input_tokens: 500,
      }),
    );
    monitor.observeMessage(
      process,
      claudeAssistantMessage({
        input_tokens: 5,
        cache_read_input_tokens: 100_505,
        cache_creation_input_tokens: 60_000,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const misses = addCacheMissBillingEvent.mock.calls.filter(
      ([, record]) => record.outcome === "unexpected-recompute",
    );
    expect(misses).toEqual([]);
  });

  it.each([
    ["compact_boundary", 1],
    ["compact_boundary", 20],
    ["microcompact_boundary", 1],
    ["microcompact_boundary", 20],
  ] as const)(
    "resets the warm-prefix baseline across %s after %d minutes",
    async (subtype, idleMinutes) => {
      const { monitor, addCacheMissBillingEvent } = monitorWith({
        enabled: true,
        minimumWastedTokens: 10_000,
        recentActivityMinutes: 10,
      });
      const process = fakeProcess();
      const startedAt = Date.now();
      const now = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(startedAt)
        .mockReturnValue(startedAt + idleMinutes * 60_000);
      try {
        monitor.observeMessage(
          process,
          claudeAssistantMessage({
            input_tokens: 5,
            cache_read_input_tokens: 150_000,
          }),
        );
        monitor.observeMessage(process, compactBoundaryMessage(subtype));
        monitor.observeMessage(
          process,
          claudeAssistantMessage({
            input_tokens: 20_000,
            cache_read_input_tokens: 0,
          }),
        );

        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(addCacheMissBillingEvent).not.toHaveBeenCalled();
      } finally {
        now.mockRestore();
      }
    },
  );

  it("charges only the excess over expected new content", async () => {
    const { monitor, addCacheMissBillingEvent } = monitorWith({
      enabled: true,
      minimumWastedTokens: 10_000,
      recentActivityMinutes: 0,
    });
    const process = fakeProcess();

    monitor.observeMessage(
      process,
      claudeAssistantMessage({
        input_tokens: 5,
        cache_read_input_tokens: 100_000,
      }),
    );
    // Prompt grew by 1000 tokens but nothing was served from cache: 100,005
    // uncached, of which only 1000 was expected.
    monitor.observeMessage(
      process,
      claudeAssistantMessage({
        input_tokens: 101_005,
        cache_read_input_tokens: 0,
      }),
    );

    await waitFor(() =>
      expect(addCacheMissBillingEvent.mock.calls.length).toBeGreaterThan(0),
    );
    const record = addCacheMissBillingEvent.mock.calls.at(-1)?.[1];
    expect(record).toMatchObject({
      outcome: "unexpected-recompute",
      wastedInputTokens: 100_005,
      expectedInputCost: {
        state: "expected-new-content",
        expectedUncachedPrefixTokens: 1000,
      },
    });
  });

  it("records a miss soon after activity without flagging it", async () => {
    const { monitor, addCacheMissBillingEvent, emit } = monitorWith({
      enabled: true,
      showToasts: true,
      minimumWastedTokens: 10_000,
      recentActivityMinutes: 10,
    });
    const process = fakeProcess();

    monitor.observeMessage(
      process,
      claudeAssistantMessage({
        input_tokens: 5,
        cache_read_input_tokens: 100_000,
      }),
    );
    monitor.observeMessage(
      process,
      claudeAssistantMessage({
        input_tokens: 100_005,
        cache_read_input_tokens: 0,
      }),
    );

    await waitFor(() =>
      expect(addCacheMissBillingEvent.mock.calls.length).toBeGreaterThan(0),
    );
    const record = addCacheMissBillingEvent.mock.calls.at(-1)?.[1];
    expect(record?.outcome).toBe("unexpected-recompute");
    expect(record?.exception).toBe(false);
    expect(record?.elapsedSinceExpectedCacheMs).toBeLessThan(10 * 60_000);
    expect(emit.mock.calls.at(-1)?.[0]).toMatchObject({ showToast: false });
  });

  it("never flags a session's first turn, which has no measured prefix", async () => {
    const { monitor, addCacheMissBillingEvent } = monitorWith({
      enabled: true,
      minimumWastedTokens: 10_000,
      recentActivityMinutes: 0,
    });

    monitor.observeMessage(
      fakeProcess({
        lastPromptCacheRefreshTime: new Date(Date.now() - 30 * 60_000),
      }),
      claudeAssistantMessage({
        input_tokens: 150_000,
        cache_read_input_tokens: 0,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(addCacheMissBillingEvent).not.toHaveBeenCalled();
  });

  it("flags a fork whose first turn read no cache", async () => {
    const { monitor, addCacheMissBillingEvent, emit } = monitorWith(
      {
        enabled: true,
        showToasts: true,
        minimumWastedTokens: 10_000,
        freshWindowMinutes: 60,
      },
      { forkedFromSessionId: "parent-1" },
    );

    monitor.observeMessage(
      fakeProcess(),
      claudeAssistantMessage({
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
      exception: true,
      messageId: "assistant-1",
      expectedCacheSource: "fork",
      wastedInputTokens: 150_000,
      expectedInputCost: {
        state: "expected-free",
        expectedUncachedPrefixTokens: 0,
        source: "fork",
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

  it("records a hit after a long gap as distribution evidence", async () => {
    const { monitor, addCacheMissBillingEvent, emit } = monitorWith({
      enabled: true,
      showToasts: true,
      minimumWastedTokens: 10_000,
      recentActivityMinutes: 10,
    });

    monitor.observeMessage(
      fakeProcess({
        lastPromptCacheRefreshTime: new Date(Date.now() - 30 * 60_000),
      }),
      claudeAssistantMessage({
        input_tokens: 50,
        cache_read_input_tokens: 150_000,
      }),
    );

    await waitFor(() => expect(addCacheMissBillingEvent).toHaveBeenCalled());
    const [, record] = addCacheMissBillingEvent.mock.calls[0]!;
    expect(record).toMatchObject({
      reason: "warm-session-cache-hit",
      outcome: "expected-cache-hit",
      exception: false,
    });
    expect(emit.mock.calls[0]?.[0]).toMatchObject({ showToast: false });
  });

  it("skips hit records for back-to-back turns", async () => {
    const { monitor, addCacheMissBillingEvent } = monitorWith({
      enabled: true,
      minimumWastedTokens: 10_000,
      recentActivityMinutes: 10,
    });
    const process = fakeProcess();

    monitor.observeMessage(
      process,
      claudeAssistantMessage({
        input_tokens: 5,
        cache_read_input_tokens: 100_000,
      }),
    );
    monitor.observeMessage(
      process,
      claudeAssistantMessage({
        input_tokens: 5,
        cache_read_input_tokens: 100_500,
        cache_creation_input_tokens: 400,
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(addCacheMissBillingEvent).not.toHaveBeenCalled();
  });
});
