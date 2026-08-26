import type { ClientSummarySourceKey } from "./clientSummaryStore";
import type { SessionRouteScrollSnapshot } from "./sessionRouteSnapshots";
import { generateUUID } from "./uuid";

export const SESSION_SCROLL_MEMORY_STORAGE_PREFIX =
  "yep-anywhere-session-scroll-memory-v1:";
const SESSION_SCROLL_MEMORY_OBSERVATION_SEGMENT = ":observation:";
let writerId: string | null = null;
let writerSequence = 0;

export interface SessionScrollMemoryReference {
  sourceKey: ClientSummarySourceKey;
  projectId: string;
  sessionId: string;
}

function encodeKeyPart(value: string): string {
  return encodeURIComponent(value);
}

export function createSessionScrollMemoryStorageKey({
  sourceKey,
  projectId,
  sessionId,
}: SessionScrollMemoryReference): string {
  return `${SESSION_SCROLL_MEMORY_STORAGE_PREFIX}${[
    sourceKey,
    projectId,
    sessionId,
  ]
    .map(encodeKeyPart)
    .join(":")}`;
}

export function isSessionScrollMemoryStorageKey(
  reference: SessionScrollMemoryReference,
  key: string,
): boolean {
  const sessionKey = createSessionScrollMemoryStorageKey(reference);
  return (
    key === sessionKey ||
    key.startsWith(`${sessionKey}${SESSION_SCROLL_MEMORY_OBSERVATION_SEGMENT}`)
  );
}

function createObservationStorageKey(
  reference: SessionScrollMemoryReference,
): string {
  writerId ??= generateUUID();
  writerSequence += 1;
  return `${createSessionScrollMemoryStorageKey(reference)}${SESSION_SCROLL_MEMORY_OBSERVATION_SEGMENT}${writerId}:${writerSequence.toString(36)}`;
}

function getStorage(): Storage | null {
  try {
    const storage = globalThis.localStorage;
    return storage && typeof storage.getItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function parseScrollSnapshot(raw: string): SessionRouteScrollSnapshot | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") {
    return null;
  }

  const snapshot = value as Partial<SessionRouteScrollSnapshot>;
  if (
    typeof snapshot.atBottom !== "boolean" ||
    !isFiniteNumber(snapshot.scrollTop) ||
    !isFiniteNumber(snapshot.scrollHeight) ||
    !isFiniteNumber(snapshot.clientHeight) ||
    !isFiniteNumber(snapshot.updatedAtMs) ||
    typeof snapshot.following !== "boolean"
  ) {
    return null;
  }

  const completedTurn = snapshot.completedTurn;
  if (
    completedTurn !== undefined &&
    (typeof completedTurn.id !== "string" ||
      completedTurn.id.length === 0 ||
      !isOptionalFiniteNumber(completedTurn.timestampMs))
  ) {
    return null;
  }

  const seenTurn = snapshot.seenTurn;
  if (
    seenTurn !== undefined &&
    (!seenTurn ||
      typeof seenTurn !== "object" ||
      typeof seenTurn.id !== "string" ||
      seenTurn.id.length === 0 ||
      !isOptionalFiniteNumber(seenTurn.timestampMs) ||
      !isOptionalFiniteNumber(seenTurn.activityIndex) ||
      (seenTurn.activityIndex !== undefined &&
        (!Number.isInteger(seenTurn.activityIndex) ||
          seenTurn.activityIndex < 0)))
  ) {
    return null;
  }

  const anchor = snapshot.anchor;
  if (
    anchor !== undefined &&
    (!anchor ||
      typeof anchor !== "object" ||
      typeof anchor.id !== "string" ||
      !isFiniteNumber(anchor.topOffset) ||
      !isOptionalString(anchor.previousId) ||
      !isOptionalString(anchor.nextId) ||
      !isOptionalFiniteNumber(anchor.timestampMs))
  ) {
    return null;
  }

  return snapshot as SessionRouteScrollSnapshot;
}

export function readSessionScrollMemory(
  reference: SessionScrollMemoryReference,
): SessionRouteScrollSnapshot | null {
  const storage = getStorage();
  if (!storage) {
    return null;
  }
  try {
    let selected: SessionRouteScrollSnapshot | undefined;
    for (const entry of readStoredSnapshots(storage, reference)) {
      selected = selectFurthestSessionScrollMemory(selected, entry.snapshot);
    }
    return selected ?? null;
  } catch {
    return null;
  }
}

interface StoredScrollSnapshot {
  key: string;
  snapshot: SessionRouteScrollSnapshot;
}

function readStoredSnapshots(
  storage: Storage,
  reference: SessionScrollMemoryReference,
): StoredScrollSnapshot[] {
  const entries: StoredScrollSnapshot[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (!key || !isSessionScrollMemoryStorageKey(reference, key)) {
      continue;
    }
    const raw = storage.getItem(key);
    const snapshot = raw === null ? null : parseScrollSnapshot(raw);
    if (snapshot) {
      entries.push({ key, snapshot });
    }
  }
  return entries;
}

function getSeenTurn(snapshot: SessionRouteScrollSnapshot) {
  return snapshot.seenTurn ?? snapshot.completedTurn;
}

function compareSeenTurns(
  left: SessionRouteScrollSnapshot,
  right: SessionRouteScrollSnapshot,
): number {
  const leftTurn = getSeenTurn(left);
  const rightTurn = getSeenTurn(right);
  if (!leftTurn) return rightTurn ? -1 : 0;
  if (!rightTurn) return 1;
  if (leftTurn.id === rightTurn.id) return 0;

  const leftTimestamp = leftTurn.timestampMs;
  const rightTimestamp = rightTurn.timestampMs;
  if (
    leftTimestamp !== undefined &&
    rightTimestamp !== undefined &&
    leftTimestamp !== rightTimestamp
  ) {
    return leftTimestamp - rightTimestamp;
  }
  return leftTurn.id.localeCompare(rightTurn.id);
}

function comparePositionsWithinTurn(
  left: SessionRouteScrollSnapshot,
  right: SessionRouteScrollSnapshot,
): number {
  const turnId = getSeenTurn(left)?.id;
  if (!turnId || getSeenTurn(right)?.id !== turnId) {
    return 0;
  }

  const leftCompleted = left.completedTurn?.id === turnId;
  const rightCompleted = right.completedTurn?.id === turnId;
  if (leftCompleted !== rightCompleted) {
    return leftCompleted ? 1 : -1;
  }

  const leftIndex = left.seenTurn?.activityIndex;
  const rightIndex = right.seenTurn?.activityIndex;
  if (
    leftIndex !== undefined &&
    rightIndex !== undefined &&
    leftIndex !== rightIndex
  ) {
    return leftIndex - rightIndex;
  }

  const leftAnchorTimestamp = left.anchor?.timestampMs;
  const rightAnchorTimestamp = right.anchor?.timestampMs;
  if (
    leftAnchorTimestamp !== undefined &&
    rightAnchorTimestamp !== undefined &&
    leftAnchorTimestamp !== rightAnchorTimestamp
  ) {
    return leftAnchorTimestamp - rightAnchorTimestamp;
  }

  const leftTopOffset = left.anchor?.topOffset;
  const rightTopOffset = right.anchor?.topOffset;
  if (
    left.anchor?.id === right.anchor?.id &&
    leftTopOffset !== undefined &&
    rightTopOffset !== undefined &&
    leftTopOffset !== rightTopOffset
  ) {
    return rightTopOffset - leftTopOffset;
  }
  if (left.following !== right.following) {
    return left.following ? 1 : -1;
  }
  return 0;
}

/** Select the furthest turn/activity reached by either visible tab. */
export function selectFurthestSessionScrollMemory(
  left: SessionRouteScrollSnapshot | null | undefined,
  right: SessionRouteScrollSnapshot | null | undefined,
): SessionRouteScrollSnapshot | undefined {
  if (!left) return right ?? undefined;
  if (!right) return left;
  return compareSessionScrollMemory(left, right) >= 0 ? left : right;
}

function compareSessionScrollMemory(
  left: SessionRouteScrollSnapshot,
  right: SessionRouteScrollSnapshot,
): number {
  return (
    compareSeenTurns(left, right) || comparePositionsWithinTurn(left, right)
  );
}

export interface WriteSessionScrollMemoryResult {
  snapshot: SessionRouteScrollSnapshot;
  written: boolean;
}

/** Advance one session's device-wide, cross-tab seen-position high-water mark. */
export function writeSessionScrollMemory(
  reference: SessionScrollMemoryReference,
  candidate: SessionRouteScrollSnapshot,
): WriteSessionScrollMemoryResult | null {
  if (typeof candidate.following !== "boolean" || !getSeenTurn(candidate)) {
    return null;
  }
  const storage = getStorage();
  if (!storage) {
    return { snapshot: candidate, written: false };
  }

  try {
    const stored = readSessionScrollMemory(reference);
    const selectedBeforeWrite =
      selectFurthestSessionScrollMemory(stored, candidate) ?? candidate;
    const candidateAdvanced =
      stored === null || compareSessionScrollMemory(candidate, stored) > 0;
    const observationKey = createObservationStorageKey(reference);
    storage.setItem(observationKey, JSON.stringify(selectedBeforeWrite));

    let entries = readStoredSnapshots(storage, reference);
    if (entries.length === 0) {
      storage.setItem(observationKey, JSON.stringify(selectedBeforeWrite));
      entries = [{ key: observationKey, snapshot: selectedBeforeWrite }];
    }
    let winner = entries[0]!;
    for (const entry of entries.slice(1)) {
      const positionOrder = compareSessionScrollMemory(
        entry.snapshot,
        winner.snapshot,
      );
      if (
        positionOrder > 0 ||
        (positionOrder === 0 && entry.key.localeCompare(winner.key) > 0)
      ) {
        winner = entry;
      }
    }

    const sessionKey = createSessionScrollMemoryStorageKey(reference);
    if (winner.key === sessionKey) {
      const durableKey = createObservationStorageKey(reference);
      storage.setItem(durableKey, JSON.stringify(winner.snapshot));
      winner = { key: durableKey, snapshot: winner.snapshot };
    }
    for (const entry of entries) {
      if (
        entry.key !== winner.key &&
        entry.key.startsWith(
          `${sessionKey}${SESSION_SCROLL_MEMORY_OBSERVATION_SEGMENT}`,
        )
      ) {
        storage.removeItem(entry.key);
      }
    }

    return {
      snapshot: winner.snapshot,
      written:
        candidateAdvanced &&
        compareSessionScrollMemory(candidate, winner.snapshot) >= 0,
    };
  } catch {
    return { snapshot: candidate, written: false };
  }
}

export function clearSessionScrollMemory(): void {
  const storage = getStorage();
  if (!storage) {
    return;
  }
  try {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(SESSION_SCROLL_MEMORY_STORAGE_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      storage.removeItem(key);
    }
  } catch {
    // Storage may be unavailable; the active in-memory mode still applies.
  }
}
