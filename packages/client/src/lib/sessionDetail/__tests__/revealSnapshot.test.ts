import { describe, expect, it } from "vitest";
import type { PaginationInfo } from "../../../api/client";
import type { Message, SessionMetadata } from "../../../types";
import type {
  SessionRouteScrollSnapshot,
  SessionRouteSnapshot,
} from "../../sessionRouteSnapshots";
import type { SessionDetailRuntimeSnapshot } from "../selectors";
import {
  buildSessionDetailRevealSnapshot,
  getCacheableSessionDetailRevealSnapshot,
} from "../revealSnapshot";

function message(uuid: string, source: Message["_source"] = "jsonl"): Message {
  return {
    uuid,
    type: "user",
    timestamp: "2026-07-03T00:00:00.000Z",
    _source: source,
    message: { role: "user", content: uuid },
  };
}

function session(id = "session-a"): SessionMetadata {
  return {
    id,
    projectId: "project-a" as SessionMetadata["projectId"],
    title: id,
    fullTitle: id,
    createdAt: "2026-07-03T00:00:00.000Z",
    updatedAt: "2026-07-03T00:00:00.000Z",
    messageCount: 1,
    ownership: { owner: "self", processId: "pid-a" },
    provider: "claude",
  };
}

function pagination(returnedMessageCount: number): PaginationInfo {
  return {
    hasOlderMessages: false,
    totalMessageCount: returnedMessageCount,
    returnedMessageCount,
    totalCompactions: 0,
  };
}

function scrollSnapshot(updatedAtMs: number): SessionRouteScrollSnapshot {
  return {
    atBottom: true,
    scrollTop: 10,
    scrollHeight: 100,
    clientHeight: 50,
    updatedAtMs,
  };
}

function runtimeSnapshot(
  overrides: Partial<SessionDetailRuntimeSnapshot> = {},
): SessionDetailRuntimeSnapshot {
  return {
    messages: [message("msg-1")],
    session: session(),
    pagination: pagination(1),
    agentContent: {},
    markdownAugments: {},
    toolUseToAgentEntries: [["tool-1", "agent-1"]],
    maxPersistedTimestampMs: 100,
    scrollSnapshot: scrollSnapshot(1),
    ...overrides,
  };
}

function fallbackSnapshot(
  overrides: Partial<SessionRouteSnapshot> = {},
): SessionRouteSnapshot {
  return {
    messages: [message("fallback")],
    session: session("fallback-session"),
    pagination: pagination(1),
    agentContent: {},
    toolUseToAgentEntries: [],
    lastMessageId: "fallback-last",
    maxPersistedTimestampMs: 50,
    scrollSnapshot: scrollSnapshot(2),
    ...overrides,
  };
}

describe("session detail reveal snapshot", () => {
  it("returns an empty transcript fallback when no store session is selected", () => {
    const fallback = fallbackSnapshot();

    const result = buildSessionDetailRevealSnapshot({
      selected: runtimeSnapshot({ session: null }),
      fallback,
    });

    expect(result.storeBacked).toBe(false);
    expect(result.snapshot).toEqual({
      messages: [],
      session: fallback.session,
      pagination: fallback.pagination,
      agentContent: {},
      markdownAugments: {},
      toolUseToAgentEntries: [],
      lastMessageId: "fallback-last",
      maxPersistedTimestampMs: 50,
      scrollSnapshot: fallback.scrollSnapshot,
    });
  });

  it("builds a route snapshot from the selected runtime snapshot", () => {
    const selectedMessages = [message("msg-1"), message("msg-2")];
    const agentContent = {
      "agent-1": { status: "running" as const, messages: [message("agent-1")] },
    };
    const markdownAugments = {
      "msg-1": { html: "<p>rendered</p>" },
    };
    const selected = runtimeSnapshot({
      messages: selectedMessages,
      agentContent,
      markdownAugments,
      lastMessageId: "selected-last",
      maxPersistedTimestampMs: 200,
    });

    const result = buildSessionDetailRevealSnapshot({
      selected,
      fallback: fallbackSnapshot(),
    });

    expect(result.storeBacked).toBe(true);
    expect(result.snapshot).toMatchObject({
      session: selected.session,
      pagination: selected.pagination,
      agentContent,
      markdownAugments,
      toolUseToAgentEntries: [["tool-1", "agent-1"]],
      lastMessageId: "selected-last",
      maxPersistedTimestampMs: 200,
      scrollSnapshot: selected.scrollSnapshot,
    });
    expect(result.snapshot.messages).toEqual(selectedMessages);
    expect(result.snapshot.messages).not.toBe(selectedMessages);
    expect(result.snapshot.toolUseToAgentEntries).not.toBe(
      selected.toolUseToAgentEntries,
    );
  });

  it("derives the cursor and falls back to retained scroll when needed", () => {
    const fallbackScroll = scrollSnapshot(3);
    const result = buildSessionDetailRevealSnapshot({
      selected: runtimeSnapshot({
        messages: [message("streamed", "sdk"), message("persisted", "jsonl")],
        lastMessageId: undefined,
        scrollSnapshot: undefined,
      }),
      fallback: fallbackSnapshot({ scrollSnapshot: fallbackScroll }),
    });

    expect(result.storeBacked).toBe(true);
    expect(result.snapshot.lastMessageId).toBe("persisted");
    expect(result.snapshot.scrollSnapshot).toBe(fallbackScroll);
  });

  it("only exposes store-backed reveal snapshots for route-cache writes", () => {
    const fallbackReveal = buildSessionDetailRevealSnapshot({
      selected: undefined,
      fallback: fallbackSnapshot(),
    });
    const storeReveal = buildSessionDetailRevealSnapshot({
      selected: runtimeSnapshot(),
      fallback: fallbackSnapshot(),
    });

    expect(getCacheableSessionDetailRevealSnapshot(fallbackReveal)).toBe(
      undefined,
    );
    expect(getCacheableSessionDetailRevealSnapshot(storeReveal)).toBe(
      storeReveal.snapshot,
    );
  });
});
