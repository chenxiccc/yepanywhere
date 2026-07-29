import {
  type CSSProperties,
  memo,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import { useI18n } from "../i18n";
import {
  MESSAGE_STALE_THRESHOLD_MS,
  getEarliestMessageTimestampMs,
  getLatestMessageTimestampMs,
} from "../lib/messageAge";
import {
  getCancellableUnconfirmedSteerTempId,
  getUserPromptDeliveryState,
} from "../lib/deliveryState";
import { useQuoteableTextSource } from "../hooks/useQuoteableTextSource";
import type { CommentAnchor } from "../lib/commentAnchors";
import type { ContentBlock } from "../types";
import type {
  ConversationRecentActivity,
  ConversationThinkingPreview as ConversationThinkingPreviewData,
  ConversationThinkingPreviewSlot,
  RenderItem,
} from "../types/renderItems";
import { formatCommandDuration } from "../lib/shellToolOutput";
import { useStickToBottom } from "../lib/stickToBottom";
import {
  THINKING_PREVIEW_DEFAULT_WIDTH_PX,
  type ThinkingPreviewWidthState,
  updateThinkingPreviewWidth,
} from "../lib/sessionDetail/thinkingPreviewWidth";
import { ThinkingText } from "./ThinkingText";
import { MessageAge } from "./MessageAge";
import {
  BangCommandDisplayObject,
  type BangCommandHandlers,
} from "./BangCommandDisplayObject";
import { ForkSummaryDisplayObject } from "./ForkSummaryDisplayObject";
import { SessionSetupBlock } from "./blocks/SessionSetupBlock";
import { TaskNotificationBlock } from "./blocks/TaskNotificationBlock";
import { TextBlock } from "./blocks/TextBlock";
import { ThinkingBlock } from "./blocks/ThinkingBlock";
import { ToolCallRow } from "./blocks/ToolCallRow";
import { UserPromptBlock } from "./blocks/UserPromptBlock";
import { LinkifiedText } from "./ui/LinkifiedText";

interface Props {
  item: RenderItem;
  isStreaming: boolean;
  thinkingExpanded: boolean;
  toggleThinkingExpanded: () => void;
  sessionProvider?: string;
  onCorrectUserPrompt?: () => void;
  onCancelUnconfirmedUserPrompt?: (tempId: string) => void;
  onTrimBeforeUserPrompt?: () => void;
  onForkBeforeUserPrompt?: () => void;
  onQuoteTextBlock?: (anchor: CommentAnchor) => void;
  alwaysShowQuoteCircle?: boolean;
  paragraphQuoteCirclesEnabled?: boolean;
  staleNowMs?: number;
  latestVisibleTimestampMs?: number | null;
  thinkingDurationMs?: number;
  getForkSummaryTargetHref?: (targetSessionId: string) => string;
  onCancelForkSummary?: (objectId: string) => void;
  onToggleForkSummaryAutoOpen?: (objectId: string, value: boolean) => void;
  onFollowForkSummary?: (objectId: string) => void;
  bangCommandHandlers?: BangCommandHandlers;
  onToggleConversationActivity?: (itemId: string) => void;
  collapsedConversationThinkingPreviewSlots?: ReadonlySet<ConversationThinkingPreviewSlot>;
  onToggleConversationThinkingPreview?: (
    slot: ConversationThinkingPreviewSlot,
  ) => void;
  onDismissConversationThinkingPreview?: (
    slot: ConversationThinkingPreviewSlot,
  ) => void;
}

function getMessageIdLike(message: Record<string, unknown>): string {
  if (typeof message.uuid === "string" && message.uuid.length > 0) {
    return message.uuid;
  }
  if (typeof message.id === "string" && message.id.length > 0) {
    return message.id;
  }
  return "<missing>";
}

function summarizeSourceMessages(messages: RenderItem["sourceMessages"]) {
  const bySource: Record<string, number> = {
    sdk: 0,
    jsonl: 0,
    unknown: 0,
  };
  const byType: Record<string, number> = {};
  const ids: string[] = [];
  let streamEventCount = 0;
  let streamingPlaceholderCount = 0;

  for (const message of messages) {
    const source =
      message._source === "sdk" || message._source === "jsonl"
        ? message._source
        : "unknown";
    bySource[source] = (bySource[source] ?? 0) + 1;

    const type = typeof message.type === "string" ? message.type : "unknown";
    byType[type] = (byType[type] ?? 0) + 1;
    if (type === "stream_event") {
      streamEventCount++;
    }
    if (message._isStreaming) {
      streamingPlaceholderCount++;
    }

    ids.push(getMessageIdLike(message as Record<string, unknown>));
  }

  return {
    total: messages.length,
    bySource,
    byType,
    streamEventCount,
    streamingPlaceholderCount,
    ids,
  };
}

function buildDebugSnapshot(
  item: RenderItem,
  props: {
    isStreaming: boolean;
    thinkingExpanded: boolean;
    sessionProvider?: string;
  },
) {
  const sourceSummary = summarizeSourceMessages(item.sourceMessages);

  return {
    render: {
      id: item.id,
      type: item.type,
      isSubagent: item.isSubagent ?? false,
    },
    uiContext: {
      sessionProvider: props.sessionProvider ?? "unknown",
      sessionIsStreaming: props.isStreaming,
      thinkingExpanded: props.thinkingExpanded,
    },
    itemContext:
      item.type === "tool_call"
        ? {
            toolName: item.toolName,
            status: item.status,
            hasToolResult: Boolean(item.toolResult),
            hasStructuredResult: item.toolResult?.structured !== undefined,
            toolUseId: item.id,
          }
        : item.type === "text"
          ? {
              isStreamingTextBlock: item.isStreaming ?? false,
              hasAugmentHtml: Boolean(item.augmentHtml),
            }
          : item.type === "thinking"
            ? {
                status: item.status,
                thinkingLength: item.thinking.length,
              }
            : item.type === "system"
              ? {
                  subtype: item.subtype,
                  status: item.status ?? null,
                }
              : item.type === "session_setup"
                ? {
                    promptCount: item.prompts.length,
                  }
                : null,
    sourceSummary,
    sourceMessages: item.sourceMessages,
    renderItem: item,
  };
}

function systemDetailToText(detail: string | ContentBlock[]): string {
  if (typeof detail === "string") {
    return detail;
  }

  return detail
    .map((block) => {
      if (block.type === "text" && typeof block.text === "string") {
        return block.text;
      }
      if (block.type === "tool_result" && typeof block.content === "string") {
        return block.content;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function CollapsibleSystemMessage({
  item,
  icon,
}: {
  item: Extract<RenderItem, { type: "system" }>;
  icon: string;
}) {
  const details = (item.details ?? [])
    .map(systemDetailToText)
    .map((text) => text.trim())
    .filter(Boolean);
  const variantClass =
    item.subtype === "compact_boundary"
      ? "system-message-compact-boundary"
      : "system-message-local-command";
  const summaryClass =
    item.subtype === "compact_boundary"
      ? "system-message-summary system-message-compact-summary"
      : "system-message-summary system-message-local-command-summary";

  if (details.length === 0) {
    return (
      <div className={`system-message ${variantClass}`}>
        <span className="system-message-icon">{icon}</span>
        <span className="system-message-text">
          <LinkifiedText text={item.content} />
        </span>
      </div>
    );
  }

  return (
    <details
      className={`system-message ${variantClass} ${variantClass}--details system-message--details`}
    >
      <summary className={summaryClass}>
        <span className="collapsible__icon" aria-hidden="true">
          ▸
        </span>
        <span className="system-message-icon">{icon}</span>
        <span className="system-message-text">
          <LinkifiedText text={item.content} />
        </span>
      </summary>
      <div className="system-message-details">
        {details.map((detail, index) => (
          <pre
            className="system-message-detail"
            key={`${item.id}-system-detail-${index}`}
          >
            {detail}
          </pre>
        ))}
      </div>
    </details>
  );
}

function ConversationActivitySummary({
  item,
  onToggle,
  collapsedThinkingPreviewSlots,
  onToggleThinkingPreview,
  onDismissThinkingPreview,
}: {
  item: Extract<RenderItem, { type: "conversation_activity" }>;
  onToggle?: (itemId: string) => void;
  collapsedThinkingPreviewSlots: ReadonlySet<ConversationThinkingPreviewSlot>;
  onToggleThinkingPreview?: (slot: ConversationThinkingPreviewSlot) => void;
  onDismissThinkingPreview?: (slot: ConversationThinkingPreviewSlot) => void;
}) {
  const { t } = useI18n();
  const rowRef = useRef<HTMLDivElement>(null);
  // Publish the current/latest thinking preview's rendered content height as a
  // CSS var on the row. Its siblings — the recent-activity list and the
  // superseded "previous" preview — cap themselves to it, so neither claims
  // more vertical space than the current thinking block requests. Capping the
  // previous preview to the current height also lets the current block own the
  // row height, so the previous preview vanishing at turn end causes no shrink
  // (and thus no autofollow flicker). See topics/responsive-layout-gaps.md.
  const previewLayoutKey = item.thinkingPreviews
    ?.map(
      (preview) =>
        `${preview.slot}:${
          collapsedThinkingPreviewSlots.has(preview.slot) ? "c" : "o"
        }`,
    )
    .join("|");
  // biome-ignore lint/correctness/useExhaustiveDependencies: previewLayoutKey re-attaches the observer when the measured preview element mounts/unmounts
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return;
    const latestCard = row.querySelector<HTMLElement>(
      '.conversation-thinking-preview[data-preview-slot="latest"]',
    );
    if (!latestCard) {
      // No current/latest preview: nothing to cap to (the previous preview
      // cannot exist and the activity list is gated off), so leave the CSS
      // fallback in place.
      row.style.removeProperty("--conversation-thinking-height");
      return;
    }
    const content = latestCard.querySelector<HTMLElement>(
      ".conversation-thinking-preview-content",
    );
    if (!content) {
      // The current/latest card is collapsed to its header. Publish 0 so the
      // previous preview and activity list clip to that header-only height too,
      // rather than falling back to the full viewport cap and rendering taller
      // than the current card — height(previous) ≤ height(current) always.
      row.style.setProperty("--conversation-thinking-height", "0px");
      return;
    }
    const publishHeight = () => {
      row.style.setProperty(
        "--conversation-thinking-height",
        `${content.offsetHeight}px`,
      );
    };
    publishHeight();
    const observer = new ResizeObserver(publishHeight);
    observer.observe(content);
    return () => observer.disconnect();
  }, [previewLayoutKey]);
  const elapsedSeconds =
    item.startedAtMs !== null &&
    item.endedAtMs !== null &&
    item.endedAtMs >= item.startedAtMs
      ? (item.endedAtMs - item.startedAtMs) / 1000
      : null;
  const duration =
    elapsedSeconds === null ? "" : formatCommandDuration(elapsedSeconds);
  const activity = t(
    item.activityCount === 1
      ? "conversationActivitySingular"
      : "conversationActivityPlural",
  );
  const label = duration
    ? t(
        item.active
          ? "conversationActivityActive"
          : "conversationActivityComplete",
        {
          duration,
          count: item.activityCount,
          activity,
        },
      )
    : t(
        item.active
          ? "conversationActivityActiveWithoutTime"
          : "conversationActivityCompleteWithoutTime",
        {
          count: item.activityCount,
          activity,
        },
      );
  const title = t(
    item.expanded
      ? "conversationActivityCollapseTitle"
      : "conversationActivityExpandTitle",
  );
  const hasExpandedThinkingPreview = item.thinkingPreviews?.some(
    (preview) => !collapsedThinkingPreviewSlots.has(preview.slot),
  );

  return (
    <div className="conversation-activity-row" ref={rowRef}>
      <div className="conversation-activity-column">
        <button
          type="button"
          className={`conversation-activity-summary${
            item.active ? " is-active" : ""
          }${item.expanded ? " is-expanded" : ""}`}
          onClick={() => onToggle?.(item.id)}
          aria-expanded={item.expanded}
          title={title}
        >
          <span className="conversation-activity-chevron" aria-hidden="true">
            {item.expanded ? "▾" : "▸"}
          </span>
          {item.active ? (
            <span className="conversation-activity-pulse" aria-hidden="true" />
          ) : null}
          <span>{label}</span>
        </button>
        {hasExpandedThinkingPreview && item.recentActivities ? (
          <ul
            className="conversation-recent-activities"
            aria-label={t("conversationRecentActivities")}
          >
            {item.recentActivities.map((activity, index) => (
              <ConversationRecentActivityName
                activity={activity}
                key={`${activity.label}-${index}`}
              />
            ))}
          </ul>
        ) : null}
      </div>
      {item.thinkingPreviews?.map((preview) => (
        <ConversationThinkingPreview
          collapsed={collapsedThinkingPreviewSlots.has(preview.slot)}
          key={preview.slot}
          onDismiss={onDismissThinkingPreview}
          onToggle={onToggleThinkingPreview}
          preview={preview}
        />
      ))}
    </div>
  );
}

function ConversationRecentActivityName({
  activity,
}: {
  activity: ConversationRecentActivity;
}) {
  const tooltipAttributes = useTextTooltipAttributes(activity.detail);
  return (
    <li {...tooltipAttributes}>
      <span className="conversation-recent-activity-name">
        {activity.label}
      </span>
      {activity.preview ? (
        <span className="conversation-recent-activity-preview">
          {activity.preview}
        </span>
      ) : null}
    </li>
  );
}

function estimateThinkingPreviewWidth(text: string): number {
  let longestLineLength = 0;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    longestLineLength = Math.max(longestLineLength, line.length);
  }
  return longestLineLength * 8;
}

function ConversationThinkingPreview({
  preview,
  collapsed,
  onToggle,
  onDismiss,
}: {
  preview: ConversationThinkingPreviewData;
  collapsed: boolean;
  onToggle?: (slot: ConversationThinkingPreviewSlot) => void;
  onDismiss?: (slot: ConversationThinkingPreviewSlot) => void;
}) {
  const { t } = useI18n();
  const contentRef = useRef<HTMLDivElement>(null);
  const [widthState, setWidthState] =
    useState<ThinkingPreviewWidthState | null>(null);
  const label = t(
    preview.kind === "current"
      ? "conversationThinkingPreviewCurrent"
      : preview.kind === "latest"
        ? "conversationThinkingPreviewLatest"
        : "conversationThinkingPreviewPrevious",
  );
  const toggleLabel = t(
    !collapsed
      ? "conversationThinkingPreviewCollapse"
      : "conversationThinkingPreviewExpand",
  );
  const dismissLabel = t("conversationThinkingPreviewDismiss", { label });
  const targetWidthPx =
    widthState?.id === preview.id
      ? widthState.targetWidthPx
      : THINKING_PREVIEW_DEFAULT_WIDTH_PX;

  useLayoutEffect(() => {
    if (collapsed) return;
    const thinkingText =
      contentRef.current?.querySelector<HTMLElement>(".thinking-text");
    if (!thinkingText) return;

    const previousDisplay = thinkingText.style.display;
    const previousWidth = thinkingText.style.width;
    const previousMaxWidth = thinkingText.style.maxWidth;
    thinkingText.style.display = thinkingText.classList.contains(
      "thinking-outline",
    )
      ? "inline-grid"
      : "inline-block";
    thinkingText.style.width = "max-content";
    thinkingText.style.maxWidth = "none";
    const measuredWidth = thinkingText.getBoundingClientRect().width;
    thinkingText.style.display = previousDisplay;
    thinkingText.style.width = previousWidth;
    thinkingText.style.maxWidth = previousMaxWidth;

    const requiredWidth =
      measuredWidth > 0
        ? measuredWidth
        : estimateThinkingPreviewWidth(preview.thinking);
    setWidthState((previous) =>
      updateThinkingPreviewWidth(previous, preview.id, requiredWidth),
    );
  }, [collapsed, preview.id, preview.thinking]);

  // Follow the streaming tail so newly appended thinking stays visible, unless
  // the user has scrolled up to read. Static/previous thinking never follows.
  const { onScroll: onContentScroll } = useStickToBottom(
    contentRef,
    preview.thinking,
    preview.status === "streaming",
  );

  return (
    <div
      className={`conversation-thinking-preview${
        preview.status === "streaming" ? " is-streaming" : ""
      }${collapsed ? " is-collapsed" : ""}`}
      data-preview-slot={preview.slot}
      style={
        {
          "--conversation-thinking-preview-target-width": `${targetWidthPx}px`,
        } as CSSProperties
      }
    >
      <div className="conversation-thinking-preview-header">
        <button
          type="button"
          className="conversation-thinking-preview-toggle"
          aria-expanded={!collapsed}
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={() => onToggle?.(preview.slot)}
        >
          <span className="conversation-thinking-preview-dot" aria-hidden />
          <span>{label}</span>
          <span className="conversation-thinking-preview-chevron" aria-hidden>
            {collapsed ? "▸" : "▾"}
          </span>
        </button>
        <button
          type="button"
          className="conversation-thinking-preview-dismiss"
          aria-label={dismissLabel}
          title={dismissLabel}
          onClick={() => onDismiss?.(preview.slot)}
        >
          ×
        </button>
      </div>
      {!collapsed ? (
        <div
          ref={contentRef}
          className="conversation-thinking-preview-content"
          onScroll={onContentScroll}
        >
          <ThinkingText
            text={preview.thinking}
            isStreaming={preview.status === "streaming"}
          />
        </div>
      ) : null}
    </div>
  );
}

export const RenderItemComponent = memo(function RenderItemComponent({
  item,
  isStreaming,
  thinkingExpanded,
  toggleThinkingExpanded,
  sessionProvider,
  onCorrectUserPrompt,
  onCancelUnconfirmedUserPrompt,
  onTrimBeforeUserPrompt,
  onForkBeforeUserPrompt,
  onQuoteTextBlock,
  alwaysShowQuoteCircle,
  paragraphQuoteCirclesEnabled,
  staleNowMs,
  latestVisibleTimestampMs,
  thinkingDurationMs,
  getForkSummaryTargetHref,
  onCancelForkSummary,
  onToggleForkSummaryAutoOpen,
  onFollowForkSummary,
  bangCommandHandlers,
  onToggleConversationActivity,
  collapsedConversationThinkingPreviewSlots = new Set<ConversationThinkingPreviewSlot>(),
  onToggleConversationThinkingPreview,
  onDismissConversationThinkingPreview,
}: Props) {
  const staticAgeNowMsRef = useRef(Date.now());
  const timestampMs = getLatestMessageTimestampMs(item.sourceMessages);
  const hasTimestamp =
    item.type !== "conversation_activity" && timestampMs !== null;
  const isLatestVisibleTimestamp =
    hasTimestamp && latestVisibleTimestampMs === timestampMs;
  const ageNowMs = isLatestVisibleTimestamp
    ? (staleNowMs ?? Date.now())
    : staticAgeNowMsRef.current;
  const showAgeByDefault =
    isLatestVisibleTimestamp &&
    ageNowMs !== null &&
    ageNowMs - timestampMs >= MESSAGE_STALE_THRESHOLD_MS;
  const recapQuoteRef = useQuoteableTextSource<HTMLSpanElement>(
    item.type === "system" && item.subtype === "away_summary"
      ? item.content
      : "",
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      // Don't interfere with text selection (important for mobile long-press)
      const selection = window.getSelection();
      if (selection && selection.toString().length > 0) {
        return;
      }

      // Shift+click to debug (not Cmd/Ctrl+click, which opens links in new tabs)
      if (e.shiftKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        e.stopPropagation();
        console.log(
          "[DEBUG] Render snapshot",
          buildDebugSnapshot(item, {
            isStreaming,
            thinkingExpanded,
            sessionProvider,
          }),
        );
      }
    },
    [item, isStreaming, thinkingExpanded, sessionProvider],
  );

  const renderContent = () => {
    switch (item.type) {
      case "text":
        return (
          <TextBlock
            text={item.text}
            isStreaming={item.isStreaming}
            augmentHtml={item.augmentHtml}
            renderItemId={item.id}
            onQuoteBlock={onQuoteTextBlock}
            alwaysShowQuoteCircle={alwaysShowQuoteCircle}
            paragraphQuoteCirclesEnabled={paragraphQuoteCirclesEnabled}
          />
        );

      case "thinking":
        return (
          <ThinkingBlock
            thinking={item.thinking}
            status={item.status}
            isExpanded={thinkingExpanded}
            onToggle={toggleThinkingExpanded}
            durationMs={thinkingDurationMs}
          />
        );

      case "tool_call":
        return (
          <ToolCallRow
            id={item.id}
            toolName={item.toolName}
            toolInput={item.toolInput}
            toolResult={item.toolResult}
            status={item.status}
            sessionProvider={sessionProvider}
            startTimestampMs={getEarliestMessageTimestampMs(
              item.sourceMessages,
            )}
            resultTimestampMs={
              item.sourceMessages.length > 1 ? timestampMs : null
            }
          />
        );

      case "user_prompt": {
        const deliveryState = getUserPromptDeliveryState(item.sourceMessages);
        const cancellableTempId = getCancellableUnconfirmedSteerTempId(
          item.sourceMessages,
        );
        return (
          <UserPromptBlock
            content={item.content}
            onCorrect={onCorrectUserPrompt}
            onCancelUnconfirmed={
              cancellableTempId && onCancelUnconfirmedUserPrompt
                ? () => onCancelUnconfirmedUserPrompt(cancellableTempId)
                : undefined
            }
            onTrimBefore={onTrimBeforeUserPrompt}
            onForkBefore={onForkBeforeUserPrompt}
            deliveryState={deliveryState}
          />
        );
      }

      case "session_setup":
        return <SessionSetupBlock title={item.title} prompts={item.prompts} />;

      case "transcript_display_object": {
        const displayObject = item.object;
        if (displayObject.kind === "bang-command") {
          return (
            <BangCommandDisplayObject
              object={displayObject}
              handlers={bangCommandHandlers}
            />
          );
        }
        return (
          <ForkSummaryDisplayObject
            object={displayObject}
            targetHref={
              displayObject.targetSessionId
                ? getForkSummaryTargetHref?.(displayObject.targetSessionId)
                : undefined
            }
            onCancel={() => onCancelForkSummary?.(displayObject.id)}
            onToggleAutoOpen={(value) =>
              onToggleForkSummaryAutoOpen?.(displayObject.id, value)
            }
            onFollow={() => onFollowForkSummary?.(displayObject.id)}
          />
        );
      }

      case "task_notification":
        return <TaskNotificationBlock item={item} />;

      case "conversation_activity":
        return (
          <ConversationActivitySummary
            item={item}
            onToggle={onToggleConversationActivity}
            collapsedThinkingPreviewSlots={
              collapsedConversationThinkingPreviewSlots
            }
            onToggleThinkingPreview={onToggleConversationThinkingPreview}
            onDismissThinkingPreview={onDismissConversationThinkingPreview}
          />
        );

      case "system": {
        if (item.subtype === "away_summary") {
          return (
            <div className="system-message-recap">
              <span className="system-message-recap-mark">※</span>
              <span ref={recapQuoteRef} className="system-message-recap-body">
                <LinkifiedText text={item.content} />
              </span>
            </div>
          );
        }

        // Different styling for compacting vs completed compaction
        const isCompacting =
          item.subtype === "status" && item.status === "compacting";
        const isError = item.subtype === "error";
        const isWarning = item.subtype === "warning";
        const isConfigAck = item.subtype === "config_ack";
        const isLocalCommand = item.subtype === "local_command";
        const isSubagentActivity = item.subtype === "subagent_activity";
        const isHighlightedConfigAck =
          isConfigAck && item.configChanged !== false;
        const icon =
          isError || isWarning
            ? "!"
            : isConfigAck
              ? "✓"
              : isLocalCommand
                ? "/"
                : isSubagentActivity
                  ? "↳"
                  : "⟳";
        if (item.subtype === "compact_boundary" || isLocalCommand) {
          return <CollapsibleSystemMessage item={item} icon={icon} />;
        }
        return (
          <div
            className={`system-message ${isCompacting ? "system-message-compacting" : ""} ${isError ? "system-message-error" : ""} ${isWarning ? "system-message-warning" : ""} ${isHighlightedConfigAck ? "system-message-config-ack" : ""} ${isLocalCommand ? "system-message-local-command" : ""}`}
          >
            <span
              className={`system-message-icon ${isCompacting ? "spinning" : ""}`}
            >
              {icon}
            </span>
            <span className="system-message-text">
              <LinkifiedText text={item.content} />
            </span>
          </div>
        );
      }

      default:
        return null;
    }
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: debug shift-click uses row-level event metadata
    // biome-ignore lint/a11y/useKeyWithClickEvents: debug feature, shift+click only
    <div
      className={[
        "message-render-row",
        hasTimestamp ? "has-message-age" : "",
        showAgeByDefault ? "is-message-age-visible" : "",
        item.isSubagent ? "subagent-item" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-render-type={item.type}
      data-render-id={item.id}
      onClick={handleClick}
    >
      <div className="message-render-content">{renderContent()}</div>
      <MessageAge timestampMs={timestampMs} nowMs={ageNowMs ?? Date.now()} />
    </div>
  );
});
