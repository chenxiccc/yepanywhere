import type { ClientSummarySourceKey } from "./clientSummaryStore";
import {
  type DraftAttachmentState,
  draftStorageValueForAttachments,
  draftStorageValueForText,
  hasDraftContentValue,
} from "./draftEnvelope";
import { publishDraftPresenceChange } from "./draftPresenceEvents";

export const SESSION_DRAFT_KEY_PREFIX = "draft-message-";
const LOCAL_CLIENT_SUMMARY_SOURCE_VALUE = "local";
const SOURCE_DRAFT_KEY_PREFIX = "draft-message:";
const SOURCE_DRAFT_INDEX_KEY_PREFIX = "draft-index-message:";
const SOURCE_DRAFT_PRESENCE_KEY_PREFIX = "draft-presence-message:";

export interface SessionDraftReference {
  sourceKey: ClientSummarySourceKey;
  sessionId: string;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export function createSessionDraftStorageKey({
  sourceKey,
  sessionId,
}: SessionDraftReference): string {
  if (sourceKey === LOCAL_CLIENT_SUMMARY_SOURCE_VALUE) {
    return `${SESSION_DRAFT_KEY_PREFIX}${sessionId}`;
  }

  return `${SOURCE_DRAFT_KEY_PREFIX}${encodeKeyPart(sourceKey)}:${encodeKeyPart(
    sessionId,
  )}`;
}

function createSessionDraftIndexKey(sourceKey: ClientSummarySourceKey): string {
  return `${SOURCE_DRAFT_INDEX_KEY_PREFIX}${encodeKeyPart(sourceKey)}`;
}

function createSessionDraftPresenceKey({
  sourceKey,
  sessionId,
}: SessionDraftReference): string {
  return `${SOURCE_DRAFT_PRESENCE_KEY_PREFIX}${encodeKeyPart(
    sourceKey,
  )}:${encodeKeyPart(sessionId)}`;
}

export function isSessionDraftStorageKey(
  key: string | null | undefined,
): boolean {
  if (!key || key.startsWith(SOURCE_DRAFT_INDEX_KEY_PREFIX)) {
    return false;
  }

  return !!(
    key.startsWith(SOURCE_DRAFT_PRESENCE_KEY_PREFIX) ||
    key.startsWith(SESSION_DRAFT_KEY_PREFIX) ||
    key.startsWith(SOURCE_DRAFT_KEY_PREFIX)
  );
}

function readLegacyDraftIndex(
  sourceKey: ClientSummarySourceKey,
): Set<string> {
  try {
    const raw = localStorage.getItem(createSessionDraftIndexKey(sourceKey));
    if (!raw) {
      return new Set();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set();
    }
    return new Set(parsed.filter((item) => typeof item === "string"));
  } catch {
    return new Set();
  }
}

function readDraftPresenceIndex(
  sourceKey: ClientSummarySourceKey,
): Set<string> {
  const result = new Set<string>();
  try {
    const prefix = `${SOURCE_DRAFT_PRESENCE_KEY_PREFIX}${encodeKeyPart(
      sourceKey,
    )}:`;
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const encodedSessionId = key.slice(prefix.length);
      if (!encodedSessionId) continue;
      try {
        result.add(decodeURIComponent(encodedSessionId));
      } catch {
        // A malformed private marker cannot identify a session.
      }
    }
  } catch {
    // localStorage might be unavailable.
  }
  return result;
}

function syncDraftPresence(
  reference: SessionDraftReference,
  shouldContain: boolean,
): { changed: boolean; synchronized: boolean } {
  try {
    const key = createSessionDraftPresenceKey(reference);
    const contains = localStorage.getItem(key) !== null;
    if (contains === shouldContain) {
      return { changed: false, synchronized: true };
    }
    if (shouldContain) {
      localStorage.setItem(key, "1");
    } else {
      localStorage.removeItem(key);
    }
    return { changed: true, synchronized: true };
  } catch {
    return { changed: false, synchronized: false };
  }
}

export function updateSessionDraftIndex(
  reference: SessionDraftReference,
  value: string | null | undefined,
): boolean {
  return syncDraftPresence(reference, hasDraftContentValue(value)).changed;
}

function persistSessionDraftEnvelope(
  reference: SessionDraftReference,
  update: (previousValue: string | null) => string | null,
): void {
  try {
    const key = createSessionDraftStorageKey(reference);
    const previousValue = localStorage.getItem(key);
    const nextValue = update(previousValue);
    if (nextValue) {
      localStorage.setItem(key, nextValue);
    } else {
      localStorage.removeItem(key);
    }
    // Reconcile on every successful envelope write, not only a presence
    // transition. A quota/transient failure on the first marker write is then
    // repaired by the next edit.
    updateSessionDraftIndex(reference, nextValue);
    const previousHasContent = hasDraftContentValue(previousValue);
    const nextHasContent = hasDraftContentValue(nextValue);
    if (previousHasContent !== nextHasContent) {
      publishDraftPresenceChange({
        storageKey: key,
        hasContent: nextHasContent,
        sessionDraft: reference,
      });
    }
  } catch {
    // localStorage might be full or unavailable.
  }
}

export function saveSessionDraft(
  reference: SessionDraftReference,
  value: string,
): void {
  persistSessionDraftEnvelope(reference, (previousValue) =>
    draftStorageValueForText(value, previousValue),
  );
}

export function saveSessionDraftAttachmentState(
  reference: SessionDraftReference,
  value: DraftAttachmentState | null,
): void {
  persistSessionDraftEnvelope(reference, (previousValue) =>
    draftStorageValueForAttachments(value, previousValue),
  );
}

export function removeSessionDraft(reference: SessionDraftReference): void {
  try {
    const key = createSessionDraftStorageKey(reference);
    const previousValue = localStorage.getItem(key);
    localStorage.removeItem(key);
    updateSessionDraftIndex(reference, "");
    if (hasDraftContentValue(previousValue)) {
      publishDraftPresenceChange({
        storageKey: key,
        hasContent: false,
        sessionDraft: reference,
      });
    }
  } catch {
    // localStorage might be unavailable.
  }
}

export function scanSessionDraftIds(
  sourceKey = LOCAL_CLIENT_SUMMARY_SOURCE_VALUE as ClientSummarySourceKey,
): Set<string> {
  const result = new Set<string>();

  try {
    const legacySessionIds = readLegacyDraftIndex(sourceKey);
    const indexedSessionIds = readDraftPresenceIndex(sourceKey);
    for (const sessionId of legacySessionIds) {
      indexedSessionIds.add(sessionId);
    }
    let migratedLegacyIndex = true;
    for (const sessionId of indexedSessionIds) {
      const value = localStorage.getItem(
        createSessionDraftStorageKey({ sourceKey, sessionId }),
      );
      if (hasDraftContentValue(value)) {
        result.add(sessionId);
      }
      const synchronized = syncDraftPresence(
        { sourceKey, sessionId },
        hasDraftContentValue(value),
      ).synchronized;
      if (
        legacySessionIds.has(sessionId) &&
        hasDraftContentValue(value) &&
        !synchronized
      ) {
        migratedLegacyIndex = false;
      }
    }
    if (legacySessionIds.size > 0 && migratedLegacyIndex) {
      localStorage.removeItem(createSessionDraftIndexKey(sourceKey));
    }

    if (sourceKey !== LOCAL_CLIENT_SUMMARY_SOURCE_VALUE) {
      return result;
    }

    // Compatibility: local-only legacy drafts predate the index. Read them only
    // for the local source, and backfill the index for non-empty keys.
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (
        !key?.startsWith(SESSION_DRAFT_KEY_PREFIX) ||
        key.startsWith(SOURCE_DRAFT_INDEX_KEY_PREFIX)
      ) {
        continue;
      }
      const value = localStorage.getItem(key);
      if (hasDraftContentValue(value)) {
        const sessionId = key.slice(SESSION_DRAFT_KEY_PREFIX.length);
        result.add(sessionId);
        updateSessionDraftIndex({ sourceKey, sessionId }, value);
      }
    }
  } catch {
    // localStorage might be unavailable.
  }

  return result;
}
