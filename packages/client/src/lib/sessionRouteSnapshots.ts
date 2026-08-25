import type { PaginationInfo } from "../api/client";
import type { Message, SessionMetadata } from "../types";
import type {
  AgentContentMap,
  MarkdownAugmentMap,
} from "./sessionDetail/types";

/**
 * Serializable transcript-window DTOs for warm route reveals; runtime
 * ownership lives in `SessionDetailMemoryCache`.
 */
export interface SessionRouteScrollSnapshot {
  atBottom: boolean;
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  anchor?: {
    id: string;
    topOffset: number;
    previousId?: string;
    nextId?: string;
    timestampMs?: number;
  };
  completedTurn?: {
    id: string;
    timestampMs?: number;
  };
  following?: boolean;
  updatedAtMs: number;
}

export interface SessionRouteSnapshot {
  messages: Message[];
  session: SessionMetadata;
  pagination?: PaginationInfo;
  agentContent: AgentContentMap;
  markdownAugments?: MarkdownAugmentMap;
  toolUseToAgentEntries: Array<[string, string]>;
  lastMessageId?: string;
  maxPersistedTimestampMs: number;
  scrollSnapshot?: SessionRouteScrollSnapshot;
}
