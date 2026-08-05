/**
 * How long a conversation-activity row holds vertical space it no longer needs.
 *
 * Long streaming thinking blocks grow the row, then give the space back the
 * moment a block is replaced by a shorter one. In follow mode that shrink drags
 * everything the reader was reading down the viewport. Holding the reserved
 * height across the gap keeps the transcript above the row still while the turn
 * alternates between thinking and activity.
 */
export const CONVERSATION_ACTIVITY_RESERVE_HOLD_MS = 30_000;

export interface ActivityHeightReserve {
  /** Height the row keeps claiming, even once its content wants less. */
  heightPx: number;
  /**
   * When the content first fell below {@link heightPx}, or `null` while the
   * reserve is still justified by real content. The hold is measured from here,
   * so content that grows back before it expires restarts the wait rather than
   * spending it.
   */
  shrankAtMs: number | null;
}

/**
 * Fold one measurement of a row's natural height into its reserve: grow at
 * once, shrink only after {@link CONVERSATION_ACTIVITY_RESERVE_HOLD_MS} of
 * continuously wanting less.
 */
export function updateActivityHeightReserve(
  previous: ActivityHeightReserve | null,
  naturalHeightPx: number,
  nowMs: number,
  holdMs: number = CONVERSATION_ACTIVITY_RESERVE_HOLD_MS,
): ActivityHeightReserve {
  if (!previous || naturalHeightPx >= previous.heightPx) {
    return { heightPx: naturalHeightPx, shrankAtMs: null };
  }
  if (previous.shrankAtMs === null) {
    return { heightPx: previous.heightPx, shrankAtMs: nowMs };
  }
  if (nowMs - previous.shrankAtMs >= holdMs) {
    return { heightPx: naturalHeightPx, shrankAtMs: null };
  }
  return previous;
}

/**
 * Milliseconds until a held reserve may be released, or `null` when nothing is
 * pending. Callers use it to wake up once at the end of the hold; content that
 * changes earlier re-measures on its own and re-arms this.
 */
export function activityHeightReserveReleaseDelayMs(
  reserve: ActivityHeightReserve,
  nowMs: number,
  holdMs: number = CONVERSATION_ACTIVITY_RESERVE_HOLD_MS,
): number | null {
  if (reserve.shrankAtMs === null) return null;
  return Math.max(0, reserve.shrankAtMs + holdMs - nowMs);
}
