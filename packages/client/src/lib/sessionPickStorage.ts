/**
 * Per-session pick persistence.
 *
 * A pick made inside a session is only realized on the server at the next
 * turn, so a change made and then abandoned (close the tab before sending)
 * would otherwise be lost: on reopen the UI falls back to the server-derived
 * value. Each store keeps the user's per-session pick in localStorage keyed
 * by session id (`<prefix><sessionId>`), so reopening an idle session
 * restores it (topics/session-defaults.md § Per-session live picks vs global
 * defaults). Effort and thinking-mode picks are intended to become stores
 * here too, rather than a third hand-rolled copy of this pattern.
 */

import type { PermissionMode } from "../types";

export interface SessionPickStore<T extends string> {
  storageKey(sessionId: string): string;
  load(sessionId: string): T | undefined;
  save(sessionId: string, value: T): void;
  remove(sessionId: string): void;
}

export function createSessionPickStore<T extends string>({
  prefix,
  decode,
  encode = (value) => value,
}: {
  prefix: string;
  /** Raw stored string → valid pick, or undefined for absent/invalid. */
  decode: (raw: string) => T | undefined;
  /** Pick → stored string; an empty result means "no override" and drops the entry. */
  encode?: (value: T) => string;
}): SessionPickStore<T> {
  const storageKey = (sessionId: string) => `${prefix}${sessionId}`;
  return {
    storageKey,
    load(sessionId) {
      if (typeof localStorage === "undefined" || !sessionId) {
        return undefined;
      }
      try {
        const raw = localStorage.getItem(storageKey(sessionId));
        return raw === null ? undefined : decode(raw);
      } catch {
        return undefined;
      }
    },
    save(sessionId, value) {
      if (typeof localStorage === "undefined" || !sessionId) {
        return;
      }
      try {
        const encoded = encode(value);
        if (encoded) {
          localStorage.setItem(storageKey(sessionId), encoded);
        } else {
          localStorage.removeItem(storageKey(sessionId));
        }
      } catch {
        // localStorage may be unavailable or full; the in-memory pick still
        // applies for the current page.
      }
    },
    remove(sessionId) {
      if (typeof localStorage === "undefined" || !sessionId) {
        return;
      }
      try {
        localStorage.removeItem(storageKey(sessionId));
      } catch {
        // localStorage may be unavailable.
      }
    },
  };
}

/**
 * Model ids are provider-local free-form strings, so there is no enum to
 * validate against; only emptiness is normalized (trim), and an empty
 * selection drops the entry so reopening falls back to the server-derived
 * model.
 */
export const sessionModelPick = createSessionPickStore<string>({
  prefix: "session-model-",
  decode: (raw) => {
    const trimmed = raw.trim();
    return trimmed ? trimmed : undefined;
  },
  encode: (value) => value.trim(),
});

/**
 * The UI-selected permission mode, validated against the mode enum on load.
 * Persisted per session so a page reload or server-process teardown restores
 * the user's choice instead of silently dropping to "default" — which would
 * re-enable provider sandboxing and approval prompts the user had
 * deliberately turned off.
 */
export const sessionPermissionModePick = createSessionPickStore<PermissionMode>(
  {
    prefix: "permission-mode-",
    decode: (raw) =>
      raw === "default" ||
      raw === "acceptEdits" ||
      raw === "plan" ||
      raw === "bypassPermissions"
        ? raw
        : undefined,
  },
);
