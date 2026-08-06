import { describe, expect, it } from "vitest";
import type { Message, SessionMetadata } from "../../../types";
import {
  createInitialSessionDetailState,
  reduceSessionDetailState,
} from "../transcriptReducer";
import type { AgentContentMap, SessionDetailState } from "../types";

const NOW_MS = Date.parse("2026-07-10T12:00:00.000Z");
const OLD_TIMESTAMP = "2026-07-01T12:00:00.000Z";

function sessionMetadata(): SessionMetadata {
  return {
    id: "session-1",
    projectId: "project-1",
    provider: "claude",
    title: "Session 1",
    createdAt: OLD_TIMESTAMP,
    updatedAt: OLD_TIMESTAMP,
    messageCount: 0,
    ownership: { owner: "none" },
  } as SessionMetadata;
}

function message(
  uuid: string,
  type: "assistant" | "user" = "assistant",
  timestamp = OLD_TIMESTAMP,
): Message {
  return {
    uuid,
    type,
    timestamp,
    message: { role: type, content: uuid },
  };
}

function taskMessage(uuid: string, toolUseId: string): Message {
  return {
    ...message(uuid),
    message: {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: toolUseId,
          name: "Task",
          input: { description: toolUseId },
        },
      ],
    },
  };
}

function agentContent(
  status: "pending" | "running" | "completed" | "failed",
  messages: Message[] = [],
): AgentContentMap[string] {
  return { status, messages };
}

function loadedState(messages: Message[]): SessionDetailState {
  return {
    ...createInitialSessionDetailState(),
    messages,
    session: sessionMetadata(),
    pagination: {
      hasOlderMessages: true,
      totalMessageCount: 100,
      returnedMessageCount: messages.length,
      truncatedBeforeMessageId: "already-older",
      totalCompactions: 5,
      totalUserTurns: 40,
      truncatedBy: "compact_boundary",
    },
    lastMessageId: "tail",
    maxPersistedTimestampMs: Date.parse(OLD_TIMESTAMP),
  };
}

describe("trimLoadedWindow reducer action", () => {
  it("atomically trims messages, pagination, and reachable auxiliary state", () => {
    const messages: Message[] = [
      taskMessage("old-task", "tool-old"),
      message("old-answer"),
      message("keep-user", "user"),
      taskMessage("keep-task", "tool-kept"),
      {
        ...message("direct-agent-result"),
        toolUseResult: { agentId: "agent-direct", status: "completed" },
      },
      message("tail"),
    ];
    const state = loadedState(messages);
    const deferredMessages = state.deferredMessages;
    const session = state.session;
    const agentKeptMessage = taskMessage("agent-kept-task", "nested-tool");
    state.markdownAugments = {
      "old-answer": { html: "<p>old</p>" },
      "keep-task": { html: "<p>kept</p>" },
      tail: { html: "<p>tail</p>" },
    };
    state.toolUseToAgentEntries = [
      ["tool-old", "agent-old"],
      ["tool-kept", "agent-kept"],
      ["nested-tool", "agent-nested"],
      ["tool-running", "agent-running"],
      ["tool-failed", "agent-failed"],
    ];
    state.agentContent = {
      "agent-old": agentContent("completed", [message("old-agent-row")]),
      "agent-kept": agentContent("completed", [agentKeptMessage]),
      "agent-nested": agentContent("completed", [message("nested-agent-row")]),
      "agent-direct": agentContent("completed", [message("direct-agent-row")]),
      "agent-running": agentContent("running", [message("running-agent-row")]),
      "agent-pending": agentContent("pending"),
      "agent-failed": agentContent("failed", [message("failed-agent-row")]),
    };

    const trimmed = reduceSessionDetailState(state, {
      type: "trimLoadedWindow",
      startMessageId: "keep-user",
      reason: "user_turn",
      nowMs: NOW_MS,
    });

    expect(trimmed.messages.map((entry) => entry.uuid)).toEqual([
      "keep-user",
      "keep-task",
      "direct-agent-result",
      "tail",
    ]);
    expect(trimmed.pagination).toEqual({
      hasOlderMessages: true,
      totalMessageCount: 100,
      returnedMessageCount: 4,
      truncatedBeforeMessageId: "keep-user",
      totalCompactions: 5,
      totalUserTurns: 40,
      truncatedBy: "user_turn",
    });
    expect(trimmed.markdownAugments).toEqual({
      "keep-task": { html: "<p>kept</p>" },
      tail: { html: "<p>tail</p>" },
    });
    expect(trimmed.toolUseToAgentEntries).toEqual([
      ["tool-kept", "agent-kept"],
      ["nested-tool", "agent-nested"],
      ["tool-running", "agent-running"],
    ]);
    expect(Object.keys(trimmed.agentContent).sort()).toEqual([
      "agent-direct",
      "agent-kept",
      "agent-nested",
      "agent-pending",
      "agent-running",
    ]);
    expect(trimmed.session).toBe(session);
    expect(trimmed.deferredMessages).toBe(deferredMessages);
    expect(trimmed.lastMessageId).toBe("tail");
    expect(trimmed.maxPersistedTimestampMs).toBe(Date.parse(OLD_TIMESTAMP));
    expect(trimmed.activeWindowTrimRevision).toBe(1);
  });

  it("creates loaded-window pagination when none existed", () => {
    const state = {
      ...loadedState([
        message("prefix"),
        message("keep", "user"),
        message("tail"),
      ]),
      pagination: undefined,
    };

    const trimmed = reduceSessionDetailState(state, {
      type: "trimLoadedWindow",
      startMessageId: "keep",
      reason: "user_turn",
      nowMs: NOW_MS,
    });

    expect(trimmed.pagination).toEqual({
      hasOlderMessages: true,
      totalMessageCount: 3,
      returnedMessageCount: 2,
      truncatedBeforeMessageId: "keep",
      totalCompactions: 0,
      truncatedBy: "user_turn",
    });
  });

  it.each([
    ["missing", "missing", OLD_TIMESTAMP],
    ["first", "prefix", OLD_TIMESTAMP],
    ["exactly 60 seconds old", "keep", new Date(NOW_MS - 60_000).toISOString()],
    ["invalid timestamp", "keep", "not-a-time"],
  ])("is a referential no-op for a %s boundary", (_label, id, timestamp) => {
    const state = loadedState([
      message("prefix"),
      message("keep", "user", timestamp),
      message("tail"),
    ]);

    expect(
      reduceSessionDetailState(state, {
        type: "trimLoadedWindow",
        startMessageId: id,
        reason: "user_turn",
        nowMs: NOW_MS,
      }),
    ).toBe(state);
    expect(state.activeWindowTrimRevision).toBe(0);
  });
});
