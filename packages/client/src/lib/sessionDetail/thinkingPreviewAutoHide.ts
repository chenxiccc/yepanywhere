/**
 * After a conversation-view turn completes with authored text following its
 * thinking, hide the thinking preview so the activity row can return to the
 * compact summary. Live turns, and completed turns whose latest content is
 * still thinking, keep the card.
 */
export const CONVERSATION_THINKING_AUTO_HIDE_MS = 5_000;
/** Height rollup plus bottom/overall fade. Longer than 1s so the shrink reads. */
export const CONVERSATION_THINKING_AUTO_HIDE_ROLLUP_MS = 1_500;

export function conversationThinkingAutoHideDelayMs({
  active,
  hasFollowingConversationText,
  endedAtMs,
  shownSinceMs = null,
  nowMs,
  hideAfterMs = CONVERSATION_THINKING_AUTO_HIDE_MS,
}: {
  active: boolean;
  hasFollowingConversationText: boolean;
  endedAtMs: number | null;
  /**
   * When the card appeared, for a preview that arrived after its turn ended —
   * a live turn's first thought, or thinking switched back on. The card is
   * glanceable for the full delay from whichever came last.
   */
  shownSinceMs?: number | null;
  nowMs: number;
  hideAfterMs?: number;
}): number | null {
  if (active || !hasFollowingConversationText) return null;
  const since =
    endedAtMs === null
      ? shownSinceMs
      : shownSinceMs === null
        ? endedAtMs
        : Math.max(endedAtMs, shownSinceMs);
  if (since === null) return 0;
  const remaining = hideAfterMs - (nowMs - since);
  return remaining > 0 ? remaining : 0;
}
