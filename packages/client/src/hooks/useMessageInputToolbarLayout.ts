import type { RefObject } from "react";
import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { ToolbarNarrowingPriority } from "./useSessionToolbarPresence";

export type ComposerOverflowTier = "none" | "early" | "medium" | "late";

const COMPOSER_OVERFLOW_TIERS: ComposerOverflowTier[] = [
  "none",
  "early",
  "medium",
  "late",
];

export interface MessageInputToolbarLayoutRefs {
  toolbar?: RefObject<HTMLDivElement | null>;
  left?: RefObject<HTMLDivElement | null>;
  status?: RefObject<HTMLDivElement | null>;
  actions?: RefObject<HTMLDivElement | null>;
}

function getFlexGapPx(element: HTMLElement): number {
  const style = getComputedStyle(element);
  return Number.parseFloat(style.columnGap || style.gap) || 0;
}

function getVisibleControlWidth(element: HTMLElement): number {
  if (element.dataset.composerElastic === "true") {
    return 0;
  }
  const style = getComputedStyle(element);
  if (style.display === "none" || style.position === "absolute") {
    return 0;
  }
  return element.getBoundingClientRect().width;
}

function getControlListWidth(element: HTMLElement): number {
  const childWidths = Array.from(element.children)
    .filter((child): child is HTMLElement => child instanceof HTMLElement)
    .map(getVisibleControlWidth)
    .filter((width) => width > 0);
  if (childWidths.length === 0) {
    return 0;
  }
  const gap = getFlexGapPx(element);
  return (
    childWidths.reduce((total, width) => total + width, 0) +
    gap * (childWidths.length - 1)
  );
}

type ComposerToolbarOverflowPriorityInput = ToolbarNarrowingPriority | "off";

export interface ComposerToolbarOverflowLayoutSignatureInput {
  modeSelector: ComposerToolbarOverflowPriorityInput;
  attachments: ComposerToolbarOverflowPriorityInput;
  slashMenu: ComposerToolbarOverflowPriorityInput;
  thinkingToggle: ComposerToolbarOverflowPriorityInput;
  renderMode: ComposerToolbarOverflowPriorityInput;
  conversationView: ComposerToolbarOverflowPriorityInput;
  browserDebug: ComposerToolbarOverflowPriorityInput;
  nudge: ComposerToolbarOverflowPriorityInput;
  sessionStatus: ComposerToolbarOverflowPriorityInput;
  shortcutsHelp: ComposerToolbarOverflowPriorityInput;
  contextUsage: ComposerToolbarOverflowPriorityInput;
  btw: ComposerToolbarOverflowPriorityInput;
  steerNow: ComposerToolbarOverflowPriorityInput;
  projectQueue: ComposerToolbarOverflowPriorityInput;
  projectQueueNewSessionShortcut: ComposerToolbarOverflowPriorityInput;
  microphone: "live" | "preview" | "off";
  waveform: boolean;
  send: "send" | "steer" | "queue" | "off" | undefined;
  queue: string;
  alternate: boolean;
  stop: boolean;
  pending: "tool-approval" | "user-question" | "off";
}

export function getComposerToolbarOverflowLayoutSignature(
  input: ComposerToolbarOverflowLayoutSignatureInput,
): string {
  return [
    `modeSelector:${input.modeSelector}`,
    `attachments:${input.attachments}`,
    `slashMenu:${input.slashMenu}`,
    `thinkingToggle:${input.thinkingToggle}`,
    `renderMode:${input.renderMode}`,
    `conversationView:${input.conversationView}`,
    `browserDebug:${input.browserDebug}`,
    `nudge:${input.nudge}`,
    `sessionStatus:${input.sessionStatus}`,
    `shortcutsHelp:${input.shortcutsHelp}`,
    `contextUsage:${input.contextUsage}`,
    `btw:${input.btw}`,
    `steerNow:${input.steerNow}`,
    `projectQueue:${input.projectQueue}`,
    `projectQueueNewSessionShortcut:${input.projectQueueNewSessionShortcut}`,
    `microphone:${input.microphone}`,
    `waveform:${input.waveform}`,
    `send:${input.send}`,
    `queue:${input.queue}`,
    `alternate:${input.alternate}`,
    `stop:${input.stop}`,
    `pending:${input.pending}`,
  ].join("|");
}

export function useMeasuredComposerOverflow({
  layoutKey,
  hasControls,
  refs,
}: {
  layoutKey: string;
  hasControls: boolean;
  refs?: MessageInputToolbarLayoutRefs;
}): {
  tier: ComposerOverflowTier;
  setToolbarRef: (node: HTMLDivElement | null) => void;
} {
  const [tier, setTier] = useState<ComposerOverflowTier>(() =>
    typeof ResizeObserver === "undefined" ? "late" : "none",
  );
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lastToolbarWidthRef = useRef(0);
  const lastLayoutKeyRef = useRef(layoutKey);
  const setToolbarRef = useCallback(
    (node: HTMLDivElement | null) => {
      toolbarRef.current = node;
      if (refs?.toolbar) {
        refs.toolbar.current = node;
      }
    },
    [refs?.toolbar],
  );

  useLayoutEffect(() => {
    if (lastLayoutKeyRef.current !== layoutKey) {
      lastLayoutKeyRef.current = layoutKey;
      const resetTier = typeof ResizeObserver === "undefined" ? "late" : "none";
      if (tier !== resetTier) {
        setTier(resetTier);
        return;
      }
    }
    const toolbar = toolbarRef.current;
    if (!toolbar || !hasControls) {
      if (tier !== "none") {
        setTier("none");
      }
      return;
    }

    let frameId: number | null = null;
    const measure = () => {
      frameId = null;
      const left =
        refs?.left?.current ?? toolbar.querySelector(".message-input-left");
      const actions =
        refs?.actions?.current ??
        toolbar.querySelector(".message-input-actions");
      if (!(left instanceof HTMLElement) || !(actions instanceof HTMLElement)) {
        return;
      }
      const leftRect = left.getBoundingClientRect();
      const actionsRect = actions.getBoundingClientRect();
      if (leftRect.width === 0 && actionsRect.width === 0) {
        setTier("late");
        return;
      }
      const leftWidth = getControlListWidth(left);
      const actionsWidth = getControlListWidth(actions);
      const overflow = toolbar.querySelector(".composer-bottom-overflow");
      const overflowWidth =
        overflow instanceof HTMLElement ? getVisibleControlWidth(overflow) : 0;
      const fileViewerSlot = toolbar.querySelector(
        '[data-file-viewer-controller-slot="true"]',
      );
      const fileViewerMinWidth =
        fileViewerSlot instanceof HTMLElement
          ? Number.parseFloat(getComputedStyle(fileViewerSlot).minWidth) || 0
          : 0;
      const visibleSectionCount = [
        leftWidth,
        fileViewerMinWidth,
        overflowWidth,
        actionsWidth,
      ].filter((width) => width > 0).length;
      const totalWidth =
        leftWidth +
        fileViewerMinWidth +
        overflowWidth +
        actionsWidth +
        getFlexGapPx(toolbar) * Math.max(0, visibleSectionCount - 1);
      const availableWidth = toolbar.getBoundingClientRect().width;
      if (totalWidth <= availableWidth + 0.5) {
        return;
      }
      setTier((currentTier) => {
        const tierIndex = COMPOSER_OVERFLOW_TIERS.indexOf(currentTier);
        return (
          COMPOSER_OVERFLOW_TIERS[
            Math.min(tierIndex + 1, COMPOSER_OVERFLOW_TIERS.length - 1)
          ] ?? "late"
        );
      });
    };
    const scheduleMeasure = () => {
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
      frameId = requestAnimationFrame(measure);
    };
    const handleResize: ResizeObserverCallback = (entries) => {
      const toolbarEntry = entries.find((entry) => entry.target === toolbar);
      if (toolbarEntry) {
        const nextWidth = toolbarEntry.contentRect.width;
        if (nextWidth > lastToolbarWidthRef.current + 1) {
          setTier("none");
        }
        lastToolbarWidthRef.current = nextWidth;
      }
      scheduleMeasure();
    };

    scheduleMeasure();
    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(handleResize);
      resizeObserver.observe(toolbar);
      if (refs?.left?.current) {
        resizeObserver.observe(refs.left.current);
      }
      if (refs?.actions?.current) {
        resizeObserver.observe(refs.actions.current);
      }
    }
    return () => {
      resizeObserver?.disconnect();
      if (frameId !== null) {
        cancelAnimationFrame(frameId);
      }
    };
  }, [tier, layoutKey, hasControls, refs?.actions, refs?.left]);

  return { tier, setToolbarRef };
}
