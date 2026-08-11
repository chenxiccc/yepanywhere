import {
  type PointerEventHandler,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import {
  announceActiveSessionHoverCard,
  createSessionHoverCardId,
  subscribeActiveSessionHoverCard,
} from "../components/sessionHoverCardRegistry";
import type { SessionStatus } from "../types";
import {
  areTooltipsSuppressed,
  beginTooltipVisibility,
  endTooltipVisibility,
  isTooltipWarm,
  subscribeTooltipSuppression,
} from "./useTooltipAppearance";

export interface SessionHoverCardAnchor {
  rowLeft: number;
  rowTop: number;
  rowRight: number;
  rowBottom: number;
  cursorX: number;
}

interface PreviewRefresh {
  projectId: string;
  sessionId: string;
  lastAgentText?: string | null;
  owner?: SessionStatus["owner"];
  available?: boolean;
}

interface SessionHoverCardControllerOptions<T extends HTMLElement> {
  targetRef: RefObject<T | null>;
  showDelayMs: number;
  warmShowDelayMs: number;
  enabled?: boolean;
  refreshPreview?: PreviewRefresh;
}

export function useSessionHoverCardController<T extends HTMLElement>({
  targetRef,
  showDelayMs,
  warmShowDelayMs,
  enabled = true,
  refreshPreview,
}: SessionHoverCardControllerOptions<T>) {
  const refreshProjectId = refreshPreview?.projectId;
  const refreshSessionId = refreshPreview?.sessionId;
  const refreshLastAgentText = refreshPreview?.lastAgentText;
  const refreshOwner = refreshPreview?.owner;
  const refreshAvailable =
    refreshPreview !== undefined && refreshPreview.available !== false;
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibilityTokenRef = useRef<symbol | null>(null);
  const cursorXRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const hoverCardIdRef = useRef<string | null>(null);
  if (!hoverCardIdRef.current) {
    hoverCardIdRef.current = createSessionHoverCardId();
  }
  const hoverCardId = hoverCardIdRef.current;
  const [anchor, setAnchor] = useState<SessionHoverCardAnchor | null>(null);
  const anchorRef = useRef<SessionHoverCardAnchor | null>(null);

  const clearShowTimer = useCallback(() => {
    if (!showTimerRef.current) return;
    clearTimeout(showTimerRef.current);
    showTimerRef.current = null;
  }, []);

  const releaseVisibility = useCallback(() => {
    const token = visibilityTokenRef.current;
    if (!token) return;
    visibilityTokenRef.current = null;
    endTooltipVisibility(token);
  }, []);

  const clear = useCallback(() => {
    clearShowTimer();
    releaseVisibility();
    anchorRef.current = null;
    setAnchor(null);
  }, [clearShowTimer, releaseVisibility]);

  const refreshIdlePreview = useCallback(() => {
    if (
      !refreshAvailable ||
      !refreshProjectId ||
      !refreshSessionId ||
      refreshLastAgentText ||
      refreshOwner === "self" ||
      refreshOwner === "external" ||
      refreshInFlightRef.current
    ) {
      return;
    }
    refreshInFlightRef.current = true;
    void api
      .refreshSessionPreview(refreshProjectId, refreshSessionId)
      .finally(() => {
        refreshInFlightRef.current = false;
      });
  }, [
    refreshAvailable,
    refreshLastAgentText,
    refreshOwner,
    refreshProjectId,
    refreshSessionId,
  ]);

  const schedule = useCallback(() => {
    if (!enabled || areTooltipsSuppressed()) {
      clear();
      return;
    }
    clearShowTimer();
    const delayMs = isTooltipWarm() ? warmShowDelayMs : showDelayMs;
    showTimerRef.current = setTimeout(() => {
      showTimerRef.current = null;
      const rect = targetRef.current?.getBoundingClientRect();
      if (!rect) return;
      refreshIdlePreview();
      announceActiveSessionHoverCard(hoverCardId);
      visibilityTokenRef.current ??= beginTooltipVisibility(clear);
      const nextAnchor = {
        rowLeft: rect.left,
        rowTop: rect.top,
        rowRight: rect.right,
        rowBottom: rect.bottom,
        cursorX: cursorXRef.current ?? rect.right,
      };
      anchorRef.current = nextAnchor;
      setAnchor(nextAnchor);
    }, delayMs);
  }, [
    clear,
    clearShowTimer,
    enabled,
    hoverCardId,
    refreshIdlePreview,
    showDelayMs,
    targetRef,
    warmShowDelayMs,
  ]);

  useEffect(
    () =>
      subscribeActiveSessionHoverCard((activeId) => {
        if (activeId !== hoverCardId) clear();
      }),
    [clear, hoverCardId],
  );

  useEffect(() => subscribeTooltipSuppression(clear), [clear]);

  useEffect(() => {
    if (!enabled) clear();
  }, [clear, enabled]);

  useEffect(
    () => () => {
      clearShowTimer();
      releaseVisibility();
    },
    [clearShowTimer, releaseVisibility],
  );

  const onPointerEnter = useCallback<PointerEventHandler<T>>(
    (event) => {
      if (event.pointerType === "touch") return;
      cursorXRef.current = event.clientX;
      schedule();
    },
    [schedule],
  );

  const onPointerMove = useCallback<PointerEventHandler<T>>(
    (event) => {
      if (event.pointerType === "touch") return;
      cursorXRef.current = event.clientX;
      if (!anchorRef.current) schedule();
    },
    [schedule],
  );

  const onPointerLeave = useCallback<PointerEventHandler<T>>(
    (event) => {
      const relatedTarget = event.relatedTarget;
      if (
        relatedTarget instanceof Element &&
        relatedTarget.closest(
          `[data-session-hovercard-id="${hoverCardId}"]`,
        ) !== null
      ) {
        return;
      }
      clear();
    },
    [clear, hoverCardId],
  );

  return {
    anchor,
    hoverCardId,
    clear,
    onPointerEnter,
    onPointerMove,
    onPointerLeave,
  };
}
