import { useCallback, useLayoutEffect, useRef } from "react";

export interface ScrollPositionAnchor {
  initialOffset: number;
  scrollRoot: HTMLElement;
}

/** Capture an element's viewport position relative to its known scroll root. */
export function captureScrollPositionAnchor(
  scrollRoot: HTMLElement | null,
  element: Element | null,
): ScrollPositionAnchor | null {
  if (!scrollRoot || !element) return null;
  return {
    scrollRoot,
    initialOffset:
      element.getBoundingClientRect().top -
      scrollRoot.getBoundingClientRect().top,
  };
}

/** Restore a captured element position after React replaces its projection. */
export function restoreScrollPositionAnchor(
  anchor: ScrollPositionAnchor | null,
  element: Element | null,
): void {
  if (!anchor || !element) return;
  const newOffset =
    element.getBoundingClientRect().top -
    anchor.scrollRoot.getBoundingClientRect().top;
  const shift = newOffset - anchor.initialOffset;
  if (Math.abs(shift) > 1) {
    anchor.scrollRoot.scrollTop += shift;
  }
}

/**
 * Preserves the visual position of a button element across a toggle that changes
 * the height of its scroll container's content. Call handleClick in place of the
 * raw toggle function; the hook adjusts scrollTop after React commits the DOM
 * change so the button appears to stay in the same viewport position.
 */
export function useScrollPreservingToggle(
  isToggled: boolean,
  toggleFn: () => void,
) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const pendingRef = useRef<ScrollPositionAnchor | null>(null);

  const handleClick = useCallback(() => {
    const btn = btnRef.current;
    if (btn) {
      let scrollRoot: HTMLElement | null = btn.parentElement;
      while (scrollRoot) {
        const { overflowY } = window.getComputedStyle(scrollRoot);
        if (overflowY === "auto" || overflowY === "scroll") break;
        scrollRoot = scrollRoot.parentElement;
      }
      pendingRef.current = captureScrollPositionAnchor(scrollRoot, btn);
    }
    toggleFn();
  }, [toggleFn]);

  // Runs synchronously after React commits the DOM — before the browser paints.
  // Corrects scrollTop so the button stays at the same viewport position.
  useLayoutEffect(() => {
    void isToggled;
    const state = pendingRef.current;
    if (!state) return;
    pendingRef.current = null;
    restoreScrollPositionAnchor(state, btnRef.current);
  }, [isToggled]);

  return { btnRef, handleClick };
}
