import {
  type FocusEvent,
  type PointerEvent,
  useCallback,
  useEffect,
  useRef,
} from "react";
import {
  areTooltipsSuppressed,
  beginTooltipVisibility,
  endTooltipVisibility,
  exceedsTooltipPointerJitter,
  getEffectiveTooltipDelayMs,
  getTooltipDelayMs,
  subscribeTooltipSuppression,
  TOOLTIP_CLOSE_DELAY_MULTIPLIER,
  useTooltipMode,
} from "./useTooltipAppearance";

interface TooltipTriggerOptions {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  delayMultiplier?: number;
}

/**
 * Dwell-delayed trigger behavior for rich tooltip surfaces that cannot use the
 * shared text-only layer. Pointer movement restarts the first-open timer;
 * keyboard-visible focus uses the same delay. Touch and pointer-generated focus
 * leave activation to the surface's click behavior. Native mode preserves each
 * surface's prior immediate hover behavior.
 */
export function useTooltipTrigger({
  open,
  onOpenChange,
  delayMultiplier = 1,
}: TooltipTriggerOptions) {
  const tooltipMode = useTooltipMode();
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibilityTokenRef = useRef<symbol | null>(null);
  const pointerRootRef = useRef<HTMLElement | null>(null);
  const lastPointerPositionRef = useRef<{ x: number; y: number } | null>(null);
  const focusWithinRef = useRef(false);
  const openRef = useRef(open);
  openRef.current = open;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (!closeTimerRef.current) return;
    clearTimeout(closeTimerRef.current);
    closeTimerRef.current = null;
  }, []);

  const releaseVisibility = useCallback(() => {
    const token = visibilityTokenRef.current;
    if (!token) return;
    visibilityTokenRef.current = null;
    endTooltipVisibility(token);
  }, []);

  const close = useCallback(() => {
    clearTimer();
    clearCloseTimer();
    releaseVisibility();
    onOpenChange(false);
  }, [clearCloseTimer, clearTimer, onOpenChange, releaseVisibility]);

  const show = useCallback(() => {
    timerRef.current = null;
    if (areTooltipsSuppressed()) {
      close();
      return;
    }
    if (!visibilityTokenRef.current && tooltipMode === "themed") {
      visibilityTokenRef.current = beginTooltipVisibility(close);
    }
    onOpenChange(true);
  }, [close, onOpenChange, tooltipMode]);

  const schedule = useCallback(() => {
    clearTimer();
    if (areTooltipsSuppressed()) return;
    if (openRef.current) return;
    const delayMs =
      tooltipMode === "native"
        ? 0
        : getEffectiveTooltipDelayMs(delayMultiplier);
    if (delayMs === 0) {
      show();
      return;
    }
    timerRef.current = setTimeout(show, delayMs);
  }, [clearTimer, delayMultiplier, show, tooltipMode]);

  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current) return;
    const delayMs =
      tooltipMode === "native"
        ? 0
        : getTooltipDelayMs() * TOOLTIP_CLOSE_DELAY_MULTIPLIER;
    if (delayMs === 0) {
      close();
      return;
    }
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      close();
    }, delayMs);
  }, [close, tooltipMode]);

  const onPointerEnter = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      pointerRootRef.current = event.currentTarget;
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      clearCloseTimer();
      schedule();
    },
    [clearCloseTimer, schedule],
  );
  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (event.pointerType === "touch") return;
      pointerRootRef.current = event.currentTarget;
      lastPointerPositionRef.current = {
        x: event.clientX,
        y: event.clientY,
      };
      clearCloseTimer();
      if (!openRef.current) schedule();
    },
    [clearCloseTimer, schedule],
  );
  const onPointerLeave = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      const position = lastPointerPositionRef.current;
      if (
        openRef.current &&
        !exceedsTooltipPointerJitter(
          position,
          event.clientX,
          event.clientY,
        )
      ) {
        return;
      }
      if (openRef.current) scheduleClose();
      else close();
    },
    [close, scheduleClose],
  );
  const onFocus = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (!event.currentTarget.matches(":focus-visible")) return;
      focusWithinRef.current = true;
      clearCloseTimer();
      schedule();
    },
    [clearCloseTimer, schedule],
  );
  const onBlur = useCallback(
    (event: FocusEvent<HTMLElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      ) {
        return;
      }
      focusWithinRef.current = false;
      close();
    },
    [close],
  );

  useEffect(() => {
    if (!open) releaseVisibility();
  }, [open, releaseVisibility]);

  useEffect(() => subscribeTooltipSuppression(close), [close]);

  useEffect(() => {
    if (!open || tooltipMode !== "themed") return;
    const handleDocumentPointerMove = (event: globalThis.PointerEvent) => {
      if (focusWithinRef.current) return;
      const root = pointerRootRef.current;
      if (
        root &&
        event.target instanceof Node &&
        root.contains(event.target)
      ) {
        return;
      }
      if (
        !exceedsTooltipPointerJitter(
          lastPointerPositionRef.current,
          event.clientX,
          event.clientY,
        )
      ) {
        return;
      }
      scheduleClose();
    };
    document.addEventListener("pointermove", handleDocumentPointerMove);
    return () =>
      document.removeEventListener("pointermove", handleDocumentPointerMove);
  }, [open, scheduleClose, tooltipMode]);

  useEffect(
    () => () => {
      clearTimer();
      clearCloseTimer();
      releaseVisibility();
    },
    [clearCloseTimer, clearTimer, releaseVisibility],
  );

  return {
    onPointerEnter,
    onPointerMove,
    onPointerLeave,
    onFocus,
    onBlur,
    cancelPending: clearTimer,
    close,
  };
}
