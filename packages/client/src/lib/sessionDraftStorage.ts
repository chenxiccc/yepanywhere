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

export function isSessionDraftStorageKey(
  key: string | null | undefined,
): boolean {
  if (!key || key.startsWith(SOURCE_DRAFT_INDEX_KEY_PREFIX)) {
    return false;
  }

  return !!(
    key.startsWith(SESSION_DRAFT_KEY_PREFIX) ||
    key.startsWith(SOURCE_DRAFT_KEY_PREFIX)
  );
}

function readDraftIndex(sourceKey: ClientSummarySourceKey): Set<string> {
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

function writeDraftIndex(
  sourceKey: ClientSummarySourceKey,
  sessionIds: ReadonlySet<string>,
): void {
  try {
    const key = createSessionDraftIndexKey(sourceKey);
    if (sessionIds.size === 0) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify([...sessionIds].sort()));
  } catch {
    // localStorage might be full or unavailable.
  }
}

export function updateSessionDraftIndex(
  reference: SessionDraftReference,
  value: string | null | undefined,
): boolean {
  const sessionIds = readDraftIndex(reference.sourceKey);
  const shouldContain = hasDraftContentValue(value);
  if (sessionIds.has(reference.sessionId) === shouldContain) {
    return false;
  }
  if (shouldContain) {
    sessionIds.add(reference.sessionId);
  } else {
    sessionIds.delete(reference.sessionId);
  }
  writeDraftIndex(reference.sourceKey, sessionIds);
  return true;
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
    const previousHasContent = hasDraftContentValue(previousValue);
    const nextHasContent = hasDraftContentValue(nextValue);
    if (previousHasContent !== nextHasContent) {
      updateSessionDraftIndex(reference, nextValue);
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
    if (hasDraftContentValue(previousValue)) {
      updateSessionDraftIndex(reference, "");
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
    const indexedSessionIds = readDraftIndex(sourceKey);
    for (const sessionId of indexedSessionIds) {
      const value = localStorage.getItem(
        createSessionDraftStorageKey({ sourceKey, sessionId }),
      );
      if (hasDraftContentValue(value)) {
        result.add(sessionId);
      } else {
        updateSessionDraftIndex({ sourceKey, sessionId }, "");
      }
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
