import type { ClientSummarySourceKey } from "./clientSummaryStore";
import type { SessionRouteScrollSnapshot } from "./sessionRouteSnapshots";

export const SESSION_SCROLL_MEMORY_STORAGE_PREFIX =
  "yep-anywhere-session-scroll-memory-v1:";

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
    const raw = storage.getItem(createSessionScrollMemoryStorageKey(reference));
    return raw === null ? null : parseScrollSnapshot(raw);
  } catch {
    return null;
  }
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
  const turnOrder = compareSeenTurns(left, right);
  if (turnOrder !== 0) {
    return turnOrder > 0 ? left : right;
  }
  const positionOrder = comparePositionsWithinTurn(left, right);
  if (positionOrder !== 0) {
    return positionOrder > 0 ? left : right;
  }
  return left;
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
    const key = createSessionScrollMemoryStorageKey(reference);
    const raw = storage.getItem(key);
    const stored = raw === null ? null : parseScrollSnapshot(raw);
    const selected =
      selectFurthestSessionScrollMemory(stored, candidate) ?? candidate;
    if (selected === stored) {
      return { snapshot: stored, written: false };
    }
    storage.setItem(key, JSON.stringify(selected));
    return { snapshot: selected, written: true };
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
