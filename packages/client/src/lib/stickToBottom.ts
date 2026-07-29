import { type RefObject, useCallback, useLayoutEffect, useRef } from "react";

/**
 * Distance in px from the bottom within which a scroll container counts as "at
 * the bottom", so follow mode stays engaged. Roughly one line of text, so a
 * user reading the tail is not knocked out of follow by sub-pixel rounding or a
 * single appended token.
 */
export const STICK_TO_BOTTOM_NEAR_PX = 32;

/** True when `el` is scrolled within `nearPx` of its bottom. */
export function isNearScrollBottom(
  el: Pick<HTMLElement, "scrollHeight" | "scrollTop" | "clientHeight">,
  nearPx = STICK_TO_BOTTOM_NEAR_PX,
): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= nearPx;
}

/**
 * Keeps a scroll container pinned to the bottom while `dependency` changes
 * (e.g. streaming text appended), unless the user has scrolled up to read.
 *
 * Follow is on by default. Scrolling away from the bottom cancels it; scrolling
 * back within {@link STICK_TO_BOTTOM_NEAR_PX} re-engages it — the "sticky near"
 * re-enable. Pass `enabled = false` for static content (e.g. finished/previous
 * thinking) so a mounted-at-top read position is never yanked to the bottom.
 *
 * Returns an `onScroll` handler to attach to the same element as `ref`.
 */
export function useStickToBottom<T extends HTMLElement>(
  ref: RefObject<T | null>,
  dependency: unknown,
  enabled = true,
): { onScroll: () => void } {
  // Follow by default; the scroll handler is the only thing that turns it off.
  const followingRef = useRef(true);

  const onScroll = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    followingRef.current = isNearScrollBottom(el);
  }, [ref]);

  // Layout effect (pre-paint) so appended content never flashes above the fold
  // before we pin to the bottom. `dependency` is intentionally the re-run
  // trigger — the body never reads it; a change means "content grew, re-pin".
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional trigger dep
  useLayoutEffect(() => {
    if (!enabled) return;
    const el = ref.current;
    if (!el || !followingRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [ref, dependency, enabled]);

  return { onScroll };
}
