import type { PaginationInfo } from "../../api/client";
import type { Message, SessionMetadata } from "../../types";
import type {
  AgentContentMap,
  MarkdownAugmentMap,
  SessionDetailState,
} from "./types";

const EMPTY_RETURNED_MESSAGES: Message[] = [];
const EMPTY_RETURNED_AGENT_CONTENT: AgentContentMap = {};
const EMPTY_RETURNED_MARKDOWN_AUGMENTS: MarkdownAugmentMap = {};

export interface ReturnedDetailStoreState {
  messages: Message[];
  agentContent: AgentContentMap;
  markdownAugments: MarkdownAugmentMap;
  toolUseToAgentEntries: Array<[string, string]>;
  activeWindowTrimRevision: number;
}

export interface StoreBackedSessionDetail {
  /** Transcript fields, gated until the route reveal completes. */
  revealed: ReturnedDetailStoreState | undefined;
  /** Loaded-window pagination; not reveal-gated so warm values stay visible. */
  pagination: PaginationInfo | undefined;
  /** Session metadata; null until reveal so loading semantics hold. */
  session: SessionMetadata | null;
}

export interface ReturnedDetailRevealGateInput {
  revealedSnapshotKey: string | null;
  snapshotKeyString: string;
  loading: boolean;
}

export function canRevealReturnedSessionDetail({
  revealedSnapshotKey,
  snapshotKeyString,
  loading,
}: ReturnedDetailRevealGateInput): boolean {
  return revealedSnapshotKey === snapshotKeyString && !loading;
}

export function createStoreBackedSessionDetailSelector(
  canRevealReturnedDetail: boolean,
): (
  state: SessionDetailState | undefined,
) => StoreBackedSessionDetail | undefined {
  let previous: StoreBackedSessionDetail | undefined;
  let previousRevealed: ReturnedDetailStoreState | undefined;
  return (
    state: SessionDetailState | undefined,
  ): StoreBackedSessionDetail | undefined => {
    if (!state) {
      return undefined;
    }
    let revealed: ReturnedDetailStoreState | undefined;
    if (canRevealReturnedDetail) {
      revealed =
        previousRevealed &&
        previousRevealed.messages === state.messages &&
        previousRevealed.agentContent === state.agentContent &&
        previousRevealed.markdownAugments === state.markdownAugments &&
        previousRevealed.toolUseToAgentEntries ===
          state.toolUseToAgentEntries &&
        previousRevealed.activeWindowTrimRevision ===
          state.activeWindowTrimRevision
          ? previousRevealed
          : {
              messages: state.messages,
              agentContent: state.agentContent,
              markdownAugments: state.markdownAugments,
              toolUseToAgentEntries: state.toolUseToAgentEntries,
              activeWindowTrimRevision: state.activeWindowTrimRevision,
            };
      previousRevealed = revealed;
    }
    const session = canRevealReturnedDetail ? state.session : null;
    if (
      previous &&
      previous.revealed === revealed &&
      previous.pagination === state.pagination &&
      previous.session === session
    ) {
      return previous;
    }
    previous = { revealed, pagination: state.pagination, session };
    return previous;
  };
}

export function getReturnedSessionMessages(
  detail: StoreBackedSessionDetail | undefined,
): Message[] {
  return detail?.revealed?.messages ?? EMPTY_RETURNED_MESSAGES;
}

export function getReturnedAgentContent(
  detail: StoreBackedSessionDetail | undefined,
): AgentContentMap {
  return detail?.revealed?.agentContent ?? EMPTY_RETURNED_AGENT_CONTENT;
}

export function getReturnedMarkdownAugments(
  detail: StoreBackedSessionDetail | undefined,
): MarkdownAugmentMap {
  return detail?.revealed?.markdownAugments ?? EMPTY_RETURNED_MARKDOWN_AUGMENTS;
}

export function buildReturnedToolUseToAgent(
  toolUseToAgentEntries:
    | ReturnedDetailStoreState["toolUseToAgentEntries"]
    | undefined,
): Map<string, string> {
  return toolUseToAgentEntries
    ? new Map(toolUseToAgentEntries)
    : new Map<string, string>();
}
