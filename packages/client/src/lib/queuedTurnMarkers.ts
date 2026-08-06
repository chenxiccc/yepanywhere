/**
 * Server-injected queued-turn markers that are not part of the user's typed
 * text: a leading compose-time staleness anchor `(Ns ago)` / `(Ms later)`
 * (optionally preceded by a `---` rule, optionally carrying a
 * `had seen: "…"` needle) and the experimental leading/trailing
 * `[sent <ISO>]` turn timestamp (YEP_TURN_TIMESTAMPS). Strip them for
 * display, search indexing, and queued-chip reconciliation; provider-bound
 * text keeps them (topics/compose-time-context-anchors.md).
 */
export const QUEUED_TURN_TIME_MARKER =
  /^(?:-{2,}\s*)?\(\d+\w* (?:ago|later)(?:, had seen: "[^"\n]*")?\)\s*/;

const TURN_TIMESTAMP_LEADING = /^\[sent [^\]\n]+\]\s*/;
const TURN_TIMESTAMP_TRAILING = /\s*\[sent [^\]\n]+\]\s*$/;

export function stripQueuedTurnMarkers(text: string): string {
  return text
    .replace(QUEUED_TURN_TIME_MARKER, "")
    .replace(TURN_TIMESTAMP_LEADING, "")
    .replace(TURN_TIMESTAMP_TRAILING, "");
}
