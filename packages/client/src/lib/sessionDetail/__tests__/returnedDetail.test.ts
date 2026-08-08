import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import type { PaginationInfo } from "../../../api/client";
import type { Message, SessionMetadata } from "../../../types";
import {
  buildReturnedToolUseToAgent,
  canRevealReturnedSessionDetail,
  createStoreBackedSessionDetailSelector,
  getReturnedAgentContent,
  getReturnedMarkdownAugments,
  getReturnedSessionMessages,
} from "../returnedDetail";
import { createInitialSessionDetailState } from "../transcriptReducer";
import type { AgentContentMap, SessionDetailState } from "../types";

function pagination(overrides: Partial<PaginationInfo> = {}): PaginationInfo {
  return {
    hasOlderMessages: true,
    totalMessageCount: 10,
    returnedMessageCount: 3,
    totalCompactions: 1,
    ...overrides,
  };
}

function session(overrides: Partial<SessionMetadata> = {}): SessionMetadata {
  return {
    id: "session-1",
    projectId: toUrlProjectId("/projects/project-1"),
    title: "Session",
    fullTitle: "Session",
    createdAt: "2026-07-06T00:00:00.000Z",
    updatedAt: "2026-07-06T00:00:00.000Z",
    messageCount: 1,
    ownership: { owner: "none" },
    provider: "claude",
    ...overrides,
  };
}

function assistantMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: "assistant-1",
    type: "assistant",
    message: { role: "assistant", content: "hello" },
    ...overrides,
  };
}

function detailState(
  overrides: Partial<SessionDetailState> = {},
): SessionDetailState {
  return {
    ...createInitialSessionDetailState(),
    messages: [assistantMessage()],
    session: session(),
    pagination: pagination(),
    ...overrides,
  };
}

describe("returned session detail helpers", () => {
  it("gates returned transcript data on the revealed route key and loading", () => {
    expect(
      canRevealReturnedSessionDetail({
        revealedSnapshotKey: "key-1",
        snapshotKeyString: "key-1",
        loading: false,
      }),
    ).toBe(true);
    expect(
      canRevealReturnedSessionDetail({
        revealedSnapshotKey: "key-1",
        snapshotKeyString: "key-2",
        loading: false,
      }),
    ).toBe(false);
    expect(
      canRevealReturnedSessionDetail({
        revealedSnapshotKey: "key-1",
        snapshotKeyString: "key-1",
        loading: true,
      }),
    ).toBe(false);
  });

  it("keeps pagination visible before reveal while hiding session and transcript data", () => {
    const selector = createStoreBackedSessionDetailSelector(false);
    const state = detailState();

    expect(selector(state)).toEqual({
      revealed: undefined,
      pagination: state.pagination,
      session: null,
    });
  });

  it("exposes store transcript references after reveal", () => {
    const selector = createStoreBackedSessionDetailSelector(true);
    const agentContent: AgentContentMap = {
      "agent-1": { status: "completed", messages: [assistantMessage()] },
    };
    const markdownAugments = {
      "assistant-1": { html: "<p>hello</p>" },
    };
    const state = detailState({
      agentContent,
      markdownAugments,
      toolUseToAgentEntries: [["tool-1", "agent-1"]],
    });

    const selected = selector(state);

    expect(selected?.session).toBe(state.session);
    expect(selected?.pagination).toBe(state.pagination);
    expect(selected?.revealed?.messages).toBe(state.messages);
    expect(selected?.revealed?.agentContent).toBe(agentContent);
    expect(selected?.revealed?.markdownAugments).toBe(markdownAugments);
    expect(selected?.revealed?.toolUseToAgentEntries).toBe(
      state.toolUseToAgentEntries,
    );
    expect(selected?.revealed?.activeWindowTrimRevision).toBe(0);
  });

  it("reuses selected objects while returned references stay unchanged", () => {
    const selector = createStoreBackedSessionDetailSelector(true);
    const state = detailState();
    const first = selector(state);
    const second = selector(state);
    const metadataOnlyUpdate = selector({
      ...state,
      maxPersistedTimestampMs: 123,
    });
    const augmentUpdate = selector({
      ...state,
      markdownAugments: { "assistant-1": { html: "<p>hello</p>" } },
    });
    const trimUpdate = selector({
      ...state,
      activeWindowTrimRevision: 1,
    });

    expect(second).toBe(first);
    expect(metadataOnlyUpdate).toBe(first);
    expect(augmentUpdate).not.toBe(first);
    expect(trimUpdate).not.toBe(first);
    expect(trimUpdate?.revealed?.activeWindowTrimRevision).toBe(1);
  });

  it("returns stable empty surfaces when detail is unrevealed or missing", () => {
    const unrevealed = createStoreBackedSessionDetailSelector(false)(
      detailState(),
    );
    const emptyMessages = getReturnedSessionMessages(undefined);
    const emptyAgentContent = getReturnedAgentContent(undefined);
    const emptyMarkdownAugments = getReturnedMarkdownAugments(undefined);

    expect(getReturnedSessionMessages(unrevealed)).toBe(emptyMessages);
    expect(getReturnedAgentContent(unrevealed)).toBe(emptyAgentContent);
    expect(getReturnedMarkdownAugments(unrevealed)).toBe(emptyMarkdownAugments);
    expect(
      buildReturnedToolUseToAgent(unrevealed?.revealed?.toolUseToAgentEntries),
    ).toEqual(new Map());
  });

  it("builds returned tool-use mappings from revealed entries", () => {
    const detail = createStoreBackedSessionDetailSelector(true)(
      detailState({
        toolUseToAgentEntries: [["tool-1", "agent-1"]],
      }),
    );

    expect(
      buildReturnedToolUseToAgent(detail?.revealed?.toolUseToAgentEntries),
    ).toEqual(new Map([["tool-1", "agent-1"]]));
  });
});
