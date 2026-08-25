import type { MarkdownAugment } from "@yep-anywhere/shared";
import type { DeferredQueueMessage, PaginationInfo } from "../../api/client";
import type { Message, SessionMetadata } from "../../types";
import type {
  SessionRouteScrollSnapshot,
  SessionRouteSnapshot,
} from "../sessionRouteSnapshots";
import type { ActiveWindowStructuralKind } from "./activeWindowTrimPolicy";

export interface AgentContent {
  messages: Message[];
  status: "pending" | "running" | "completed" | "failed";
  contextUsage?: {
    inputTokens: number;
    percentage: number;
  };
}

export type AgentContextUsage = NonNullable<AgentContent["contextUsage"]>;
export type AgentContentMap = Record<string, AgentContent>;
export type MarkdownAugmentMap = Record<string, MarkdownAugment>;

export interface SessionDetailState {
  messages: Message[];
  session: SessionMetadata | null;
  pagination?: PaginationInfo;
  agentContent: AgentContentMap;
  markdownAugments: MarkdownAugmentMap;
  toolUseToAgentEntries: Array<[string, string]>;
  lastMessageId?: string;
  maxPersistedTimestampMs: number;
  deferredMessages: DeferredQueueMessage[];
  /** Ephemeral mount/store signal incremented only by an accepted auto-trim. */
  activeWindowTrimRevision: number;
}

export interface SessionDetailReconciliationContext {
  /**
   * The connected server aligns Codex live and durable message ids. Missing
   * means legacy server behavior so hosted clients fail toward deduplication.
   */
  codexStreamDurableIdAlignment?: boolean;
}

export type SessionDetailAction = (
  | {
      type: "restoreRouteSnapshot";
      snapshot: SessionRouteSnapshot;
    }
  | {
      type: "loadPersistedTranscript";
      messages: Message[];
      session: SessionMetadata;
      pagination?: PaginationInfo;
      agentContent?: AgentContentMap;
      markdownAugments?: MarkdownAugmentMap;
      toolUseToAgentEntries?: Array<[string, string]>;
      deferredMessages?: DeferredQueueMessage[];
      scrollSnapshot?: SessionRouteScrollSnapshot;
    }
  | {
      type: "setSessionMetadata";
      session: SessionMetadata | null;
    }
  | {
      type: "applyStreamMessage";
      message: Message;
      fromBufferedReplay?: boolean;
      streamingEnabled?: boolean;
    }
  | {
      type: "applyStreamSubagentMessage";
      agentId: string;
      message: Message;
      streamingEnabled?: boolean;
    }
  | {
      type: "upsertStreamingPlaceholder";
      message: Message;
      agentId?: string;
    }
  | {
      type: "registerToolUseAgent";
      toolUseId: string;
      agentId: string;
    }
  | {
      type: "mergeLoadedAgentContent";
      agentId: string;
      content: AgentContent;
    }
  | {
      type: "updateAgentContextUsage";
      agentId: string;
      contextUsage: AgentContextUsage;
    }
  | {
      type: "clearAgentStreamingPlaceholders";
      agentId: string;
    }
  | {
      type: "clearStreamingPlaceholders";
    }
  | {
      type: "removeUnconfirmedSelfSend";
      tempId: string;
    }
  | {
      type: "applyCatchupMessages";
      messages: Message[];
      session?: SessionMetadata;
      pagination?: PaginationInfo;
    }
  | {
      type: "replaceTailWindow";
      messages: Message[];
      session: SessionMetadata;
      pagination?: PaginationInfo;
    }
  | {
      type: "trimLoadedWindow";
      startMessageId: string;
      reason: ActiveWindowStructuralKind;
      nowMs: number;
    }
  | {
      type: "prependOlderMessages";
      messages: Message[];
      pagination?: PaginationInfo;
    }
  | {
      type: "applyFinalMarkdownAugment";
      messageId: string;
      augment: MarkdownAugment;
    }
) &
  SessionDetailReconciliationContext;
