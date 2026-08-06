import type {
  SessionRouteScrollSnapshot,
  SessionRouteSnapshot,
} from "../sessionRouteSnapshots";
import {
  createInitialSessionDetailState,
  reduceSessionDetailState,
} from "./transcriptReducer";
import type { SessionDetailState } from "./types";

export function cloneScrollSnapshot(
  scrollSnapshot: SessionRouteScrollSnapshot,
): SessionRouteScrollSnapshot {
  if (typeof structuredClone === "function") {
    return structuredClone(scrollSnapshot);
  }
  return JSON.parse(
    JSON.stringify(scrollSnapshot),
  ) as SessionRouteScrollSnapshot;
}

export function routeSnapshotToState(
  snapshot: SessionRouteSnapshot,
): SessionDetailState {
  return reduceSessionDetailState(createInitialSessionDetailState(), {
    type: "restoreRouteSnapshot",
    snapshot,
  });
}

export function stateToRouteSnapshot(
  state: SessionDetailState,
  scrollSnapshot?: SessionRouteScrollSnapshot,
): SessionRouteSnapshot | undefined {
  if (!state.session) {
    return undefined;
  }
  return {
    messages: state.messages,
    session: state.session,
    pagination: state.pagination,
    agentContent: state.agentContent,
    toolUseToAgentEntries: state.toolUseToAgentEntries,
    lastMessageId: state.lastMessageId,
    maxPersistedTimestampMs: state.maxPersistedTimestampMs,
    scrollSnapshot: scrollSnapshot
      ? cloneScrollSnapshot(scrollSnapshot)
      : undefined,
  };
}
