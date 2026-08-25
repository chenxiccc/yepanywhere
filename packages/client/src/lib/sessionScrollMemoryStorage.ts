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
    typeof snapshot.following !== "boolean" ||
    !snapshot.completedTurn ||
    typeof snapshot.completedTurn.id !== "string" ||
    snapshot.completedTurn.id.length === 0 ||
    !isOptionalFiniteNumber(snapshot.completedTurn.timestampMs)
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

function compareCompletedTurns(
  left: SessionRouteScrollSnapshot,
  right: SessionRouteScrollSnapshot,
): number {
  const leftTurn = left.completedTurn;
  const rightTurn = right.completedTurn;
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
  if (left.updatedAtMs !== right.updatedAtMs) {
    return left.updatedAtMs - right.updatedAtMs;
  }
  return leftTurn.id.localeCompare(rightTurn.id);
}

/**
 * Select the device cursor that has reached the furthest completed turn.
 * Following is a tie-breaker, never an exclusive claim on the session.
 */
export function selectFurthestSessionScrollMemory(
  left: SessionRouteScrollSnapshot | null | undefined,
  right: SessionRouteScrollSnapshot | null | undefined,
): SessionRouteScrollSnapshot | undefined {
  if (!left) return right ?? undefined;
  if (!right) return left;
  const turnOrder = compareCompletedTurns(left, right);
  if (turnOrder !== 0) {
    return turnOrder > 0 ? left : right;
  }
  if (left.following !== right.following) {
    return left.following ? left : right;
  }
  return left.updatedAtMs >= right.updatedAtMs ? left : right;
}

export interface WriteSessionScrollMemoryResult {
  snapshot: SessionRouteScrollSnapshot;
  written: boolean;
}

/**
 * Advance one session's device cursor. Older observations and repeated
 * same-turn state are reads; a parked-to-following upgrade writes once.
 */
export function writeSessionScrollMemory(
  reference: SessionScrollMemoryReference,
  candidate: SessionRouteScrollSnapshot,
): WriteSessionScrollMemoryResult | null {
  if (!candidate.completedTurn || typeof candidate.following !== "boolean") {
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
    if (stored) {
      const turnOrder = compareCompletedTurns(candidate, stored);
      const upgradesSameTurnToFollowing =
        turnOrder === 0 && candidate.following && !stored.following;
      if (turnOrder < 0 || (turnOrder === 0 && !upgradesSameTurnToFollowing)) {
        return { snapshot: stored, written: false };
      }
    }
    storage.setItem(key, JSON.stringify(candidate));
    return { snapshot: candidate, written: true };
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
