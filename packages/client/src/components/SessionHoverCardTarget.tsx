import type { ProviderName } from "@yep-anywhere/shared";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { useHoverCardSettings } from "../hooks/useHoverCardAppearance";
import {
  beginTooltipVisibility,
  endTooltipVisibility,
  isTooltipWarm,
} from "../hooks/useTooltipAppearance";
import { useSessionCollectionRecord } from "../lib/clientSummaryStore";
import { formatSessionHoverAge } from "../lib/sessionAge";
import { SessionHoverCard } from "./SessionHoverCard";
import {
  announceActiveSessionHoverCard,
  createSessionHoverCardId,
  subscribeActiveSessionHoverCard,
} from "./sessionHoverCardRegistry";

export interface SessionHoverCardFallback {
  projectId: string;
  title: string;
  provider: ProviderName;
  model?: string;
}

/**
 * Adds the canonical session preview card to a non-list target. The target's
 * carried identity is sufficient for a fallback card; the shared session
 * summary store enriches it with the opening request, recent reply, age, and
 * live status when available.
 */
export function SessionHoverCardTarget({
  sessionId,
  fallback,
  children,
  className,
}: {
  sessionId: string;
  fallback: SessionHoverCardFallback;
  children: ReactNode;
  className?: string;
}) {
  const record = useSessionCollectionRecord(sessionId);
  const { showDelayMs, maxHeightPx } = useHoverCardSettings();
  const targetRef = useRef<HTMLSpanElement>(null);
  const cursorXRef = useRef(0);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const visibilityTokenRef = useRef<symbol | null>(null);
  const refreshInFlightRef = useRef(false);
  const hoverCardIdRef = useRef<string | null>(null);
  if (!hoverCardIdRef.current) {
    hoverCardIdRef.current = createSessionHoverCardId();
  }
  const [anchor, setAnchor] = useState<{
    rowTop: number;
    rowBottom: number;
    cursorX: number;
  } | null>(null);

  const releaseVisibility = useCallback(() => {
    const token = visibilityTokenRef.current;
    if (!token) return;
    visibilityTokenRef.current = null;
    endTooltipVisibility(token);
  }, []);

  const clear = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
    releaseVisibility();
    setAnchor(null);
  }, [releaseVisibility]);

  const refreshIdlePreview = useCallback(() => {
    if (
      !record ||
      record.lastAgentText ||
      record.ownership?.owner === "self" ||
      record.ownership?.owner === "external" ||
      refreshInFlightRef.current
    ) {
      return;
    }
    refreshInFlightRef.current = true;
    void api
      .refreshSessionPreview(fallback.projectId, sessionId)
      .finally(() => {
        refreshInFlightRef.current = false;
      });
  }, [fallback.projectId, record, sessionId]);

  const schedule = useCallback(() => {
    if (showTimerRef.current) {
      clearTimeout(showTimerRef.current);
    }
    refreshIdlePreview();
    showTimerRef.current = setTimeout(
      () => {
        const rect = targetRef.current?.getBoundingClientRect();
        const hoverCardId = hoverCardIdRef.current;
        if (!rect || !hoverCardId) return;
        announceActiveSessionHoverCard(hoverCardId);
        visibilityTokenRef.current ??= beginTooltipVisibility(clear);
        setAnchor({
          rowTop: rect.top,
          rowBottom: rect.bottom,
          cursorX: cursorXRef.current || rect.right,
        });
        showTimerRef.current = null;
      },
      isTooltipWarm() ? 0 : showDelayMs,
    );
  }, [clear, refreshIdlePreview, showDelayMs]);

  useEffect(
    () =>
      subscribeActiveSessionHoverCard((activeId) => {
        if (activeId !== hoverCardIdRef.current) {
          clear();
        }
      }),
    [clear],
  );

  useEffect(() => {
    if (!anchor) return;
    const dismiss = () => clear();
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
    };
  }, [anchor, clear]);

  useEffect(() => () => clear(), [clear]);

  const isOwnCard = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    const hoverCardId = hoverCardIdRef.current;
    return (
      !!hoverCardId &&
      target.closest(`[data-session-hovercard-id="${hoverCardId}"]`) !== null
    );
  }, []);

  const hasCustomTitle = !!record?.customTitle;
  const prompt =
    (hasCustomTitle
      ? record?.title
      : (record?.initialPrompt ?? record?.fullTitle ?? record?.title)
    )?.trim() || fallback.title;
  const provider = record?.provider ?? fallback.provider;

  return (
    <span
      ref={targetRef}
      className={className}
      onPointerEnter={(event) => {
        if (event.pointerType === "touch") return;
        cursorXRef.current = event.clientX;
        schedule();
      }}
      onPointerMove={(event) => {
        if (event.pointerType !== "touch") {
          cursorXRef.current = event.clientX;
        }
      }}
      onPointerLeave={(event) => {
        if (!isOwnCard(event.relatedTarget)) {
          clear();
        }
      }}
    >
      {children}
      {anchor && (
        <SessionHoverCard
          hoverCardId={hoverCardIdRef.current!}
          anchor={anchor}
          prompt={prompt}
          lastAgentText={record?.lastAgentText}
          provider={provider}
          model={record?.model ?? fallback.model}
          projectName={record?.projectName}
          ageLabel={formatSessionHoverAge(record?.updatedAt, record?.createdAt)}
          status={record?.ownership}
          pendingInputType={record?.pendingInputType}
          hasUnread={record?.hasUnread}
          activity={record?.activity}
          maxHeightPx={maxHeightPx}
          onMouseLeave={clear}
        />
      )}
    </span>
  );
}
