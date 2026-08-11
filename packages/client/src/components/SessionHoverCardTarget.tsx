import type { ProviderName } from "@yep-anywhere/shared";
import { type ReactNode, useEffect, useRef } from "react";
import { useHoverCardSettings } from "../hooks/useHoverCardAppearance";
import { useSessionHoverCardController } from "../hooks/useSessionHoverCardController";
import { useSessionCollectionRecord } from "../lib/clientSummaryStore";
import { formatSessionHoverAge } from "../lib/sessionAge";
import { SessionHoverCard } from "./SessionHoverCard";

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
  const { showDelayMs, warmShowDelayMs, maxHeightPx } = useHoverCardSettings();
  const targetRef = useRef<HTMLSpanElement>(null);
  const {
    anchor,
    hoverCardId,
    clear,
    onPointerEnter,
    onPointerMove,
    onPointerLeave,
  } = useSessionHoverCardController({
    targetRef,
    showDelayMs,
    warmShowDelayMs,
    refreshPreview: {
      projectId: fallback.projectId,
      sessionId,
      lastAgentText: record?.lastAgentText,
      owner: record?.ownership?.owner,
      available: !!record,
    },
  });

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
      onPointerEnter={onPointerEnter}
      onPointerMove={onPointerMove}
      onPointerLeave={onPointerLeave}
    >
      {children}
      {anchor && (
        <SessionHoverCard
          hoverCardId={hoverCardId}
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
