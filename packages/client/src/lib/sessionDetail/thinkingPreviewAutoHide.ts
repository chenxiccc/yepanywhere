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
  nowMs,
  hideAfterMs = CONVERSATION_THINKING_AUTO_HIDE_MS,
}: {
  active: boolean;
  hasFollowingConversationText: boolean;
  endedAtMs: number | null;
  nowMs: number;
  hideAfterMs?: number;
}): number | null {
  if (active || !hasFollowingConversationText) return null;
  if (endedAtMs === null) return 0;
  const remaining = hideAfterMs - (nowMs - endedAtMs);
  return remaining > 0 ? remaining : 0;
}
