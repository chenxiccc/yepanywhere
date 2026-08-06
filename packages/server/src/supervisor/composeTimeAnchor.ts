/**
 * Compose-time context anchors for queued (deferred) message delivery.
 *
 * When a user message is queued while the agent is busy and delivered later,
 * the agent benefits from knowing how stale the message is relative to the work
 * it just did. At delivery (send) time — never at queue time — the first
 * delivered chunk is prefixed with `(Ns ago)` (whole seconds from composition to
 * delivery) and each later chunk with `(Ms later)` (whole seconds after the
 * previous chunk was composed). Anchors below {@link MIN_COMPOSE_ANCHOR_SECONDS}
 * are omitted as noise — a freshly delivered message needs no staleness note.
 *
 * This mirrors the harness "Queued-send time separators" convention so the agent
 * reads queued staleness the same way regardless of which supervisor delivered
 * the turn. Units are whole seconds to match that convention. See
 * topics/compose-time-context-anchors.md.
 */

/** Below this many seconds, a compose-time anchor is omitted as noise. */
export const MIN_COMPOSE_ANCHOR_SECONDS = 10;

/** Max chars of last-seen assistant text quoted in a first-chunk anchor. */
export const MAX_SEEN_NEEDLE_CHARS = 60;

/**
 * Sanitize raw assistant output into a single-line quotable needle: the
 * verbatim tail (what the composer was looking at), whitespace collapsed,
 * double quotes swapped for single so the anchor's own quoting survives.
 * A verbatim substring lets the model attend directly to the anchored
 * span in its context; an ordinal like "3 turns back" would demand turn
 * counting models do poorly.
 */
export function composeSeenNeedle(raw: string): string | null {
  const collapsed = raw.replace(/\s+/g, " ").replaceAll('"', "'").trim();
  if (!collapsed) return null;
  if (collapsed.length <= MAX_SEEN_NEEDLE_CHARS) return collapsed;
  return `…${collapsed.slice(-MAX_SEEN_NEEDLE_CHARS)}`;
}

/**
 * Anchor text for one delivered chunk, or null when below threshold or when a
 * timestamp is unusable (NaN). The first chunk anchors against delivery time;
 * a later chunk anchors against the previous chunk's compose time.
 *
 * @param composedAtMs server-clock epoch ms this chunk was composed/queued
 * @param deliveredAtMs server-clock epoch ms of delivery (computed at send time)
 * @param previousComposedAtMs prior chunk's compose time, or null for the first
 * @param lastSeenNeedle sanitized tail of the assistant output the composer
 *   had seen (first chunk only); quoted as `had seen: "…"`
 * @param elapsedVisible false when absolute `[sent …]` turn timestamps are
 *   on: every chunk is stamped, so relative elapsed text is derivable and
 *   suppressed — only the content needle survives, as `(had seen: "…")`
 */
export function composeTimeAnchor(
  composedAtMs: number,
  deliveredAtMs: number,
  previousComposedAtMs: number | null,
  lastSeenNeedle: string | null = null,
  elapsedVisible = true,
): string | null {
  if (previousComposedAtMs === null) {
    const seconds = Math.round((deliveredAtMs - composedAtMs) / 1000);
    if (!Number.isFinite(seconds) || seconds < MIN_COMPOSE_ANCHOR_SECONDS) {
      return null;
    }
    if (!elapsedVisible) {
      return lastSeenNeedle ? `(had seen: "${lastSeenNeedle}")` : null;
    }
    const seen = lastSeenNeedle ? `, had seen: "${lastSeenNeedle}"` : "";
    return `(${seconds}s ago${seen})`;
  }
  if (!elapsedVisible) return null;
  const seconds = Math.round((composedAtMs - previousComposedAtMs) / 1000);
  if (!Number.isFinite(seconds) || seconds < MIN_COMPOSE_ANCHOR_SECONDS) {
    return null;
  }
  return `(${seconds}s later)`;
}

/**
 * Anchors for an ordered batch of chunks delivered together at `deliveredAtMs`.
 * Returns one entry per chunk (string or null), preserving order. The first
 * chunk anchors against delivery time and may carry the group's last-seen
 * needle; each later chunk anchors against the previous chunk's compose time.
 */
export function composeTimeAnchors(
  composedAtMsList: number[],
  deliveredAtMs: number,
  lastSeenNeedles?: (string | null)[],
  elapsedVisible = true,
): (string | null)[] {
  return composedAtMsList.map((composedAtMs, index) =>
    composeTimeAnchor(
      composedAtMs,
      deliveredAtMs,
      index === 0 ? null : composedAtMsList[index - 1]!,
      index === 0 ? (lastSeenNeedles?.[0] ?? null) : null,
      elapsedVisible,
    ),
  );
}
