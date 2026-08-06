import type { ClientSummarySourceKey } from "./clientSummaryStore";

export interface DraftPresenceChange {
  storageKey: string;
  hasContent: boolean;
  sessionDraft?: {
    sourceKey: ClientSummarySourceKey;
    sessionId: string;
  };
}

const listeners = new Set<(change: DraftPresenceChange) => void>();

export function publishDraftPresenceChange(change: DraftPresenceChange): void {
  for (const listener of listeners) {
    listener(change);
  }
}

export function subscribeDraftPresenceChanges(
  listener: (change: DraftPresenceChange) => void,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
