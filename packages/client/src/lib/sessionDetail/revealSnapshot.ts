import type { PaginationInfo } from "../../api/client";
import type { Message, SessionMetadata } from "../../types";
import type {
  SessionRouteScrollSnapshot,
  SessionRouteSnapshot,
} from "../sessionRouteSnapshots";
import type { SessionDetailRuntimeSnapshot } from "./selectors";
import { findLastJsonlMessageId } from "./transcriptReducer";

export interface SessionDetailRevealSnapshotFallback {
  session: SessionMetadata;
  pagination?: PaginationInfo;
  lastMessageId?: string;
  maxPersistedTimestampMs: number;
  scrollSnapshot?: SessionRouteScrollSnapshot;
}

export interface SessionDetailRevealSnapshotResult {
  snapshot: SessionRouteSnapshot;
  storeBacked: boolean;
}

export function getCacheableSessionDetailRevealSnapshot(
  reveal: SessionDetailRevealSnapshotResult,
): SessionRouteSnapshot | undefined {
  return reveal.storeBacked ? reveal.snapshot : undefined;
}

export function buildSessionDetailRevealSnapshot({
  selected,
  fallback,
}: {
  selected: SessionDetailRuntimeSnapshot | undefined;
  fallback: SessionDetailRevealSnapshotFallback;
}): SessionDetailRevealSnapshotResult {
  if (!selected?.session) {
    return {
      storeBacked: false,
      snapshot: {
        messages: [],
        session: fallback.session,
        pagination: fallback.pagination,
        agentContent: {},
        markdownAugments: {},
        toolUseToAgentEntries: [],
        lastMessageId: fallback.lastMessageId,
        maxPersistedTimestampMs: fallback.maxPersistedTimestampMs,
        scrollSnapshot: fallback.scrollSnapshot,
      },
    };
  }

  const selectedMessages: Message[] = [...selected.messages];
  return {
    storeBacked: true,
    snapshot: {
      messages: selectedMessages,
      session: selected.session,
      pagination: selected.pagination,
      agentContent: selected.agentContent,
      markdownAugments: selected.markdownAugments,
      toolUseToAgentEntries: selected.toolUseToAgentEntries.map(
        ([toolUseId, agentId]) => [toolUseId, agentId],
      ),
      lastMessageId:
        selected.lastMessageId ?? findLastJsonlMessageId(selectedMessages),
      maxPersistedTimestampMs: selected.maxPersistedTimestampMs,
      scrollSnapshot: selected.scrollSnapshot ?? fallback.scrollSnapshot,
    },
  };
}
