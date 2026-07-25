/**
 * Per-session model persistence.
 *
 * A model picked for a specific session is only realized on the server at the
 * next turn, so a change made and then abandoned (close the tab before sending)
 * would otherwise be lost: on reopen the picker falls back to the JSONL-derived
 * `session.model`. This store keeps the user's per-session pick in localStorage,
 * keyed by session id, so reopening an idle session restores it — mirroring the
 * per-session permission-mode persistence in `useSession` (see
 * `topics/session-defaults.md`).
 *
 * Model ids are provider-local free-form strings, so there is no enum to
 * validate against here; we only guard emptiness and localStorage availability.
 */

const SESSION_MODEL_KEY_PREFIX = "session-model-";

export function getSessionModelStorageKey(sessionId: string): string {
  return `${SESSION_MODEL_KEY_PREFIX}${sessionId}`;
}

export function loadStoredSessionModel(sessionId: string): string | undefined {
  if (typeof localStorage === "undefined" || !sessionId) {
    return undefined;
  }
  try {
    const raw = localStorage.getItem(getSessionModelStorageKey(sessionId));
    const trimmed = raw?.trim();
    return trimmed ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

export function saveStoredSessionModel(sessionId: string, model: string): void {
  if (typeof localStorage === "undefined" || !sessionId) {
    return;
  }
  try {
    const trimmed = model.trim();
    if (trimmed) {
      localStorage.setItem(getSessionModelStorageKey(sessionId), trimmed);
    } else {
      // An empty selection means "no per-session override"; drop the entry so
      // reopening falls back to the server-derived model.
      localStorage.removeItem(getSessionModelStorageKey(sessionId));
    }
  } catch {
    // localStorage may be unavailable or full; the in-memory model still
    // applies for the current page.
  }
}

export function removeStoredSessionModel(sessionId: string): void {
  if (typeof localStorage === "undefined" || !sessionId) {
    return;
  }
  try {
    localStorage.removeItem(getSessionModelStorageKey(sessionId));
  } catch {
    // localStorage may be unavailable.
  }
}
