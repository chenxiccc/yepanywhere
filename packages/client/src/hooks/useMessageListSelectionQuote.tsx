import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import {
  SELECTION_ACTION_BUTTON_MOBILE_SIZE_PX,
  SELECTION_ACTION_BUTTON_SIZE_PX,
  SELECTION_ACTION_GAP_PX,
  SelectionActionButton,
  SelectionActionCluster,
  type SelectionActionKind,
} from "../components/ui/SelectionActionCluster";
import {
  createCommentAnchor,
  type CommentAnchor,
  draftQuoteSignaturesContainAnchor,
  getCommentAnchorRange,
  getDraftQuoteLineSignatures,
} from "../lib/commentAnchors";
import type {
  ComposerDraftChange,
  ComposerDraftSignal,
} from "../lib/composerDraftSignal";
import { writeClipboardRichText, writeClipboardText } from "../lib/clipboard";
import {
  copyMarkdownSelectionToClipboard,
  extractMarkdownSnippetsFromSelection,
  getQuoteSelectionRoot,
  getQuoteSelectionRootForTarget,
  type MarkdownSelectionSnippet,
} from "../lib/markdownSelectionCopy";
import { getSemanticHtmlClipboardPayload } from "../lib/semanticHtmlClipboard";
import { useI18n } from "../i18n";
import { useQuoteReplyButtonMode } from "./useQuoteReplyButtonMode";
import { useSelectionActionPreferences } from "./useSelectionActionPreferences";

const TRANSCRIPT_SELECTION_ACTIVE_CLASS = "session-transcript-selection-active";

type FloatingActionPlacement = "above" | "after" | "before" | "below";

interface SelectionActionSnapshot {
  anchors: readonly CommentAnchor[];
  snippets: readonly MarkdownSelectionSnippet[];
  ranges: readonly Range[];
  root: HTMLElement;
}

interface SelectionActionState {
  top: number;
  left: number;
  side: FloatingActionPlacement;
  docked: boolean;
  mobile: boolean;
  snapshot: SelectionActionSnapshot;
}

interface UseMessageListSelectionQuoteOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  inert: boolean;
  onQuoteSelection?: (quotedText: string) => string | null;
  onStartNewSessionFromSelection?: (prefill: string) => void;
  composerDraftSignal?: ComposerDraftSignal;
  quoteClearSignal: number;
  isInteractiveTarget: (target: EventTarget | null) => boolean;
}

interface MessageListSelectionQuoteState {
  alwaysShowQuoteCircles: boolean;
  paragraphQuoteCirclesEnabled: boolean;
  handleQuoteTextBlock: (anchor: CommentAnchor) => void;
  mobileSelectionActions: ReactNode;
  floatingSelectionActions: ReactNode;
  selectionContextMenu: ReactNode;
}

function selectionText(snapshot: SelectionActionSnapshot): string {
  return snapshot.snippets
    .map((snippet, index) => {
      const range = snapshot.ranges[index];
      if (!range) return snippet.selectedText;
      return (
        getSemanticHtmlClipboardPayload(snapshot.root, [range])?.text ??
        snippet.selectedText
      );
    })
    .join("\n\n");
}

function selectionSource(snapshot: SelectionActionSnapshot): string {
  return snapshot.snippets.map((snippet) => snippet.markdown).join("\n\n");
}

function selectionQuote(snapshot: SelectionActionSnapshot): string {
  return snapshot.anchors.map((anchor) => anchor.quotedText).join("\n\n");
}

function selectionLocationLabel(
  snapshot: SelectionActionSnapshot,
): string | null {
  const locations = snapshot.snippets.map((snippet) => snippet.sourceLocation);
  if (locations.some((location) => location === undefined)) {
    return null;
  }
  const first = locations[0];
  if (
    !first ||
    locations.some(
      (location) =>
        location?.projectId !== first.projectId ||
        location.filePath !== first.filePath,
    )
  ) {
    return null;
  }
  const lineStart = Math.min(
    ...locations.map((location) => location?.lineStart ?? first.lineStart),
  );
  const lineEnd = Math.max(
    ...locations.map((location) => location?.lineEnd ?? first.lineEnd),
  );
  return `${first.filePath}:${lineStart}${lineEnd > lineStart ? `-${lineEnd}` : ""}`;
}

function newSessionSelectionPrefill(snapshot: SelectionActionSnapshot): string {
  const quote = selectionQuote(snapshot);
  const location = selectionLocationLabel(snapshot);
  return location ? `${location}\n\n${quote}` : quote;
}

function pointIntersectsSelection(
  snapshot: SelectionActionSnapshot,
  x: number,
  y: number,
): boolean {
  if (x === 0 && y === 0) return true;
  return snapshot.ranges.some((range) => {
    if (typeof range.getClientRects !== "function") return true;
    return Array.from(range.getClientRects()).some(
      (rect) =>
        x >= rect.left - 1 &&
        x <= rect.right + 1 &&
        y >= rect.top - 1 &&
        y <= rect.bottom + 1,
    );
  });
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function rangeSideIsClear(
  snippet: MarkdownSelectionSnippet,
  side: "after" | "before",
  lineRect: Pick<DOMRect, "bottom" | "top">,
): boolean {
  const remainder = snippet.sourceElement.ownerDocument.createRange();
  remainder.selectNodeContents(snippet.sourceElement);
  if (side === "after") {
    remainder.setStart(snippet.range.endContainer, snippet.range.endOffset);
  } else {
    remainder.setEnd(snippet.range.startContainer, snippet.range.startOffset);
  }
  if (!remainder.toString().trim()) {
    return true;
  }
  if (typeof remainder.getClientRects !== "function") {
    return true;
  }
  return !Array.from(remainder.getClientRects()).some(
    (rect) =>
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > lineRect.top + 1 &&
      rect.top < lineRect.bottom - 1,
  );
}

function selectionSourceTextRects(
  snippets: readonly MarkdownSelectionSnippet[],
): DOMRect[] {
  const sourceElements = new Set(
    snippets.map((snippet) => snippet.sourceElement),
  );
  const rects: DOMRect[] = [];
  for (const sourceElement of sourceElements) {
    const contentRange = sourceElement.ownerDocument.createRange();
    contentRange.selectNodeContents(sourceElement);
    if (typeof contentRange.getClientRects !== "function") {
      continue;
    }
    rects.push(
      ...Array.from(contentRange.getClientRects()).filter(
        (rect) => rect.width > 0 && rect.height > 0,
      ),
    );
  }
  return rects;
}

function selectionSourceBounds(
  snippets: readonly MarkdownSelectionSnippet[],
): Pick<DOMRect, "bottom" | "left" | "right" | "top"> | null {
  const sourceElements = new Set(
    snippets.map((snippet) => snippet.sourceElement),
  );
  let bounds: Pick<DOMRect, "bottom" | "left" | "right" | "top"> | null = null;
  for (const sourceElement of sourceElements) {
    const rect = sourceElement.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      continue;
    }
    bounds = bounds
      ? {
          top: Math.min(bounds.top, rect.top),
          right: Math.max(bounds.right, rect.right),
          bottom: Math.max(bounds.bottom, rect.bottom),
          left: Math.min(bounds.left, rect.left),
        }
      : rect;
  }
  return bounds;
}

function rectanglesOverlap(
  first: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
  second: Pick<DOMRect, "bottom" | "left" | "right" | "top">,
): boolean {
  return (
    first.left < second.right &&
    first.right > second.left &&
    first.top < second.bottom &&
    first.bottom > second.top
  );
}

function shouldShieldTranscriptSelection(win: Window): boolean {
  return win.matchMedia?.("(pointer: coarse)").matches === true;
}

export function useSelectionActions({
  containerRef,
  inert,
  onQuoteSelection,
  onStartNewSessionFromSelection,
  composerDraftSignal,
  quoteClearSignal,
  isInteractiveTarget,
}: UseMessageListSelectionQuoteOptions): MessageListSelectionQuoteState {
  const selectionPointerStartedRef = useRef(false);
  const selectionActionPointerAppliedRef = useRef<SelectionActionKind | null>(
    null,
  );
  const quoteInsertionDraftRef = useRef<string | null>(null);
  const commentAnchorsRef = useRef<readonly CommentAnchor[]>([]);
  const draftSubscriptionRef = useRef<(() => void) | null>(null);
  const composerDraftSignalRef = useRef(composerDraftSignal);
  const reconcileDraftChangeRef = useRef<(change: ComposerDraftChange) => void>(
    () => {},
  );
  const [selectionActions, setSelectionActions] =
    useState<SelectionActionState | null>(null);
  const { quoteReplyButtonMode } = useQuoteReplyButtonMode();
  const {
    selectionQuoteActionEnabled,
    selectionTextCopyActionEnabled,
    selectionSourceCopyActionEnabled,
    selectionRichCopyActionEnabled,
    selectionNewSessionActionEnabled,
  } = useSelectionActionPreferences();
  const alwaysShowQuoteCircles = quoteReplyButtonMode === "paragraph-always";
  const paragraphQuoteCirclesEnabled = quoteReplyButtonMode !== "block";
  const { t } = useI18n();
  const { menu: selectionContextMenu, openAt: openSelectionContextMenuAt } =
    useSourceContextMenu(t, {
      dismiss: t("sessionDismissSelectionActions" as never),
      menu: t("sessionSelectionActionMenu" as never),
    });

  const applyCommentHighlight = useCallback(
    (anchors: readonly CommentAnchor[]) => {
      if (
        typeof CSS === "undefined" ||
        !("highlights" in CSS) ||
        typeof Highlight === "undefined"
      ) {
        return;
      }

      if (anchors.length === 0) {
        CSS.highlights.delete("comment-tint");
        return;
      }

      const ranges = anchors
        .map(getCommentAnchorRange)
        .filter((range): range is Range => range !== null);
      if (ranges.length === 0) {
        CSS.highlights.delete("comment-tint");
        return;
      }
      CSS.highlights.set("comment-tint", new Highlight(...ranges));
    },
    [],
  );

  const releaseDraftSubscription = useCallback(() => {
    draftSubscriptionRef.current?.();
    draftSubscriptionRef.current = null;
  }, []);

  const refreshDraftSubscription = useCallback(() => {
    releaseDraftSubscription();
    const signal = composerDraftSignalRef.current;
    if (!signal || commentAnchorsRef.current.length === 0) {
      return;
    }
    draftSubscriptionRef.current = signal.subscribeDraftChanges((change) => {
      reconcileDraftChangeRef.current(change);
    });
  }, [releaseDraftSubscription]);

  const updateCommentAnchors = useCallback(
    (next: readonly CommentAnchor[]) => {
      const previous = commentAnchorsRef.current;
      if (next === previous) {
        return;
      }
      commentAnchorsRef.current = next;
      applyCommentHighlight(next);
      if (previous.length === 0 && next.length > 0) {
        refreshDraftSubscription();
      } else if (previous.length > 0 && next.length === 0) {
        releaseDraftSubscription();
      }
    },
    [applyCommentHighlight, refreshDraftSubscription, releaseDraftSubscription],
  );

  reconcileDraftChangeRef.current = (change) => {
    const previous = commentAnchorsRef.current;
    if (previous.length === 0) {
      return;
    }
    const insertionDraft = quoteInsertionDraftRef.current;
    if (
      insertionDraft === null &&
      change.metadata.mayAffectQuoteAnchors === false
    ) {
      return;
    }
    quoteInsertionDraftRef.current = null;
    const draftSignatures = getDraftQuoteLineSignatures(
      insertionDraft ?? change.text,
    );
    const next = previous.filter((anchor) =>
      draftQuoteSignaturesContainAnchor(draftSignatures, anchor),
    );
    if (next.length !== previous.length) {
      updateCommentAnchors(next);
    }
  };

  useEffect(() => {
    composerDraftSignalRef.current = composerDraftSignal;
    refreshDraftSubscription();
    return releaseDraftSubscription;
  }, [composerDraftSignal, refreshDraftSubscription, releaseDraftSubscription]);

  useEffect(
    () => () => {
      releaseDraftSubscription();
      applyCommentHighlight([]);
    },
    [applyCommentHighlight, releaseDraftSubscription],
  );

  const applyQuoteAnchors = useCallback(
    (anchors: readonly CommentAnchor[], typedPrefix = "") => {
      if (!onQuoteSelection || anchors.length === 0) {
        return false;
      }
      const quotedText = anchors
        .map((anchor) => anchor.quotedText)
        .join("\n\n");
      const nextDraft = onQuoteSelection(
        typedPrefix ? `${quotedText}\n${typedPrefix}` : `${quotedText}\n`,
      );
      if (nextDraft === null) {
        return false;
      }
      quoteInsertionDraftRef.current = nextDraft;
      updateCommentAnchors([...commentAnchorsRef.current, ...anchors]);
      containerRef.current?.ownerDocument.getSelection()?.removeAllRanges();
      setSelectionActions(null);
      return true;
    },
    [containerRef, onQuoteSelection, updateCommentAnchors],
  );

  const applyQuoteFromSelection = useCallback(
    (typedPrefix = "") => {
      const root = containerRef.current;
      if (!root) {
        return false;
      }
      const selectionRoot = getQuoteSelectionRoot(root);
      if (!selectionRoot) {
        return false;
      }
      const anchors =
        extractMarkdownSnippetsFromSelection(selectionRoot).map(
          createCommentAnchor,
        );
      return applyQuoteAnchors(anchors, typedPrefix);
    },
    [applyQuoteAnchors, containerRef],
  );

  const handleQuoteTextBlock = useCallback(
    (anchor: CommentAnchor) => {
      applyQuoteAnchors([anchor]);
    },
    [applyQuoteAnchors],
  );

  const captureSelectionActionSnapshot = useCallback(() => {
    const root = containerRef.current;
    const selection = root?.ownerDocument.getSelection();
    if (
      !root ||
      !selection ||
      selection.isCollapsed ||
      selection.rangeCount === 0
    ) {
      return null;
    }
    const selectionRoot = getQuoteSelectionRoot(root, selection);
    if (!selectionRoot) {
      return null;
    }
    const snippets = extractMarkdownSnippetsFromSelection(selectionRoot);
    if (snippets.length === 0) {
      return null;
    }
    return {
      anchors: snippets.map(createCommentAnchor),
      snippets,
      ranges: snippets.map((snippet) => snippet.range.cloneRange()),
      root: selectionRoot,
    } satisfies SelectionActionSnapshot;
  }, [containerRef]);

  useEffect(() => {
    if (quoteClearSignal > 0) {
      updateCommentAnchors([]);
    }
  }, [quoteClearSignal, updateCommentAnchors]);

  useEffect(() => {
    if (inert) {
      return;
    }
    const handleCopy = (event: ClipboardEvent) => {
      const root = containerRef.current;
      if (!root) {
        return;
      }

      const selectionRoot = getQuoteSelectionRoot(root);
      if (selectionRoot) {
        copyMarkdownSelectionToClipboard(event, selectionRoot);
      }
    };

    document.addEventListener("copy", handleCopy);
    return () => document.removeEventListener("copy", handleCopy);
  }, [containerRef, inert]);

  useEffect(() => {
    if (inert) {
      return;
    }

    const root = containerRef.current;
    const doc = root?.ownerDocument ?? document;
    const win = doc.defaultView ?? window;
    if (!shouldShieldTranscriptSelection(win)) {
      return;
    }

    let activeSessionPage: HTMLElement | null = null;
    let activeBody: HTMLElement | null = null;

    const setTranscriptSelectionActive = (active: boolean) => {
      const root = containerRef.current;
      const sessionPage = root?.closest<HTMLElement>(".session-page") ?? null;
      const body = root?.ownerDocument.body ?? null;
      if (activeSessionPage && activeSessionPage !== sessionPage) {
        activeSessionPage.classList.remove(TRANSCRIPT_SELECTION_ACTIVE_CLASS);
      }
      if (activeBody && activeBody !== body) {
        activeBody.classList.remove(TRANSCRIPT_SELECTION_ACTIVE_CLASS);
      }

      activeSessionPage = sessionPage;
      activeBody = body;
      sessionPage?.classList.toggle(TRANSCRIPT_SELECTION_ACTIVE_CLASS, active);
      body?.classList.toggle(
        TRANSCRIPT_SELECTION_ACTIVE_CLASS,
        active && sessionPage !== null,
      );
    };

    const updateTranscriptSelectionActive = () => {
      const root = containerRef.current;
      if (!root) {
        setTranscriptSelectionActive(false);
        return;
      }
      setTranscriptSelectionActive(
        getQuoteSelectionRoot(root, root.ownerDocument.getSelection()) !== null,
      );
    };

    doc.addEventListener("selectionchange", updateTranscriptSelectionActive);
    doc.addEventListener("pointerup", updateTranscriptSelectionActive, true);
    doc.addEventListener("keyup", updateTranscriptSelectionActive, true);
    win.addEventListener("blur", updateTranscriptSelectionActive);

    return () => {
      doc.removeEventListener(
        "selectionchange",
        updateTranscriptSelectionActive,
      );
      doc.removeEventListener(
        "pointerup",
        updateTranscriptSelectionActive,
        true,
      );
      doc.removeEventListener("keyup", updateTranscriptSelectionActive, true);
      win.removeEventListener("blur", updateTranscriptSelectionActive);
      activeSessionPage?.classList.remove(TRANSCRIPT_SELECTION_ACTIVE_CLASS);
      activeBody?.classList.remove(TRANSCRIPT_SELECTION_ACTIVE_CLASS);
    };
  }, [containerRef, inert]);

  useEffect(() => {
    const quoteActionAvailable =
      selectionQuoteActionEnabled && onQuoteSelection !== undefined;
    const actionCount = [
      selectionTextCopyActionEnabled,
      selectionSourceCopyActionEnabled,
      selectionRichCopyActionEnabled,
      quoteActionAvailable,
      selectionNewSessionActionEnabled &&
        onStartNewSessionFromSelection !== undefined,
    ].filter(Boolean).length;
    if (inert || actionCount === 0) {
      setSelectionActions(null);
      return;
    }

    const updateSelectionActions = (pointerEnd?: {
      clientX: number;
      clientY: number;
    }) => {
      const root = containerRef.current;
      const selection = root?.ownerDocument.getSelection();
      const snapshot = captureSelectionActionSnapshot();
      if (!root || !selection || !snapshot) {
        setSelectionActions(null);
        return;
      }
      const { snippets } = snapshot;
      const selectionRoot = snapshot.root;

      const win = root.ownerDocument.defaultView ?? window;
      const mobile = shouldShieldTranscriptSelection(win);
      const buttonSize = mobile
        ? SELECTION_ACTION_BUTTON_MOBILE_SIZE_PX
        : SELECTION_ACTION_BUTTON_SIZE_PX;

      const range = selection.getRangeAt(selection.rangeCount - 1);
      const rangeRect =
        typeof range.getBoundingClientRect === "function"
          ? range.getBoundingClientRect()
          : null;
      const lineRects =
        typeof range.getClientRects === "function"
          ? Array.from(range.getClientRects()).filter(
              (rect) => rect.width !== 0 || rect.height !== 0,
            )
          : [];
      const hasRangeRect =
        rangeRect && (rangeRect.width !== 0 || rangeRect.height !== 0);
      if (!hasRangeRect && !pointerEnd) {
        setSelectionActions(null);
        return;
      }
      const rootRect = selectionRoot.getBoundingClientRect();
      const selectionRect = hasRangeRect
        ? rangeRect
        : {
            top: pointerEnd?.clientY ?? rootRect.top,
            right: pointerEnd?.clientX ?? rootRect.left,
            bottom: pointerEnd?.clientY ?? rootRect.top,
            left: pointerEnd?.clientX ?? rootRect.left,
            width: 0,
            height: 0,
          };
      const firstLineRect = lineRects[0] ?? selectionRect;
      const lastLineRect = lineRects.at(-1) ?? selectionRect;
      const clusterWidth =
        actionCount * buttonSize + (actionCount - 1) * SELECTION_ACTION_GAP_PX;
      const firstSnippet = snippets[0];
      const lastSnippet = snippets.at(-1);
      const afterIsClear = lastSnippet
        ? rangeSideIsClear(lastSnippet, "after", lastLineRect)
        : false;
      const beforeIsClear = firstSnippet
        ? rangeSideIsClear(firstSnippet, "before", firstLineRect)
        : false;
      const sourceBounds = selectionSourceBounds(snippets) ?? selectionRect;
      const spaceAfter = rootRect.right - lastLineRect.right;
      const spaceBefore = firstLineRect.left - rootRect.left;
      const spaceBelow = rootRect.bottom - sourceBounds.bottom;
      const spaceAbove = sourceBounds.top - rootRect.top;
      const maxTop = Math.max(0, selectionRoot.clientHeight - buttonSize);
      const maxLeft = Math.max(0, selectionRoot.clientWidth - clusterWidth);
      const centeredLeft =
        selectionRect.left -
        rootRect.left +
        (selectionRect.width - clusterWidth) / 2;
      const candidates: Record<
        FloatingActionPlacement,
        { left: number; top: number }
      > = {
        after: {
          top:
            lastLineRect.top -
            rootRect.top +
            (lastLineRect.height - buttonSize) / 2,
          left: lastLineRect.right - rootRect.left + SELECTION_ACTION_GAP_PX,
        },
        before: {
          top:
            firstLineRect.top -
            rootRect.top +
            (firstLineRect.height - buttonSize) / 2,
          left:
            firstLineRect.left -
            rootRect.left -
            clusterWidth -
            SELECTION_ACTION_GAP_PX,
        },
        below: {
          top: sourceBounds.bottom - rootRect.top + SELECTION_ACTION_GAP_PX,
          left: centeredLeft,
        },
        above: {
          top:
            sourceBounds.top -
            rootRect.top -
            buttonSize -
            SELECTION_ACTION_GAP_PX,
          left: centeredLeft,
        },
      };
      const sourceTextRects = selectionSourceTextRects(snippets);
      const candidateIsClear = (side: FloatingActionPlacement) => {
        if (side === "after" && !afterIsClear) return false;
        if (side === "before" && !beforeIsClear) return false;
        const candidate = candidates[side];
        if (
          candidate.left < 0 ||
          candidate.top < 0 ||
          candidate.left + clusterWidth > selectionRoot.clientWidth ||
          candidate.top + buttonSize > selectionRoot.clientHeight
        ) {
          return false;
        }
        const viewportCandidate = {
          top: rootRect.top + candidate.top,
          right: rootRect.left + candidate.left + clusterWidth,
          bottom: rootRect.top + candidate.top + buttonSize,
          left: rootRect.left + candidate.left,
        };
        if (
          viewportCandidate.left < 0 ||
          viewportCandidate.top < 0 ||
          viewportCandidate.right > win.innerWidth ||
          viewportCandidate.bottom > win.innerHeight
        ) {
          return false;
        }
        return !sourceTextRects.some((rect) =>
          rectanglesOverlap(viewportCandidate, rect),
        );
      };
      const side =
        (["after", "before", "below", "above"] as const).find(
          candidateIsClear,
        ) ??
        (
          [
            ["after", spaceAfter - clusterWidth],
            ["before", spaceBefore - clusterWidth],
            ["below", spaceBelow - buttonSize],
            ["above", spaceAbove - buttonSize],
          ] as const
        ).reduce((best, candidate) =>
          candidate[1] > best[1] ? candidate : best,
        )[0];
      const position = candidates[side];
      setSelectionActions({
        side,
        docked: mobile && selectionRoot === root,
        mobile,
        snapshot,
        top: clampNumber(position.top, 0, maxTop),
        left: clampNumber(position.left, 0, maxLeft),
      });
    };
    const handlePointerDown = (event: PointerEvent) => {
      const root = containerRef.current;
      if (!root || !getQuoteSelectionRootForTarget(root, event.target)) {
        selectionPointerStartedRef.current = false;
        return;
      }
      selectionPointerStartedRef.current = true;
    };
    const handlePointerUp = (event: PointerEvent) => {
      const selectionPointerStarted = selectionPointerStartedRef.current;
      selectionPointerStartedRef.current = false;
      if (!selectionPointerStarted) {
        return;
      }
      window.setTimeout(() => {
        updateSelectionActions({
          clientX: event.clientX,
          clientY: event.clientY,
        });
      }, 0);
    };
    const updateFromSelectionRange = () => updateSelectionActions();

    document.addEventListener("selectionchange", updateFromSelectionRange);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("pointerup", handlePointerUp, true);
    window.addEventListener("resize", updateFromSelectionRange);
    window.addEventListener("scroll", updateFromSelectionRange, true);
    return () => {
      document.removeEventListener("selectionchange", updateFromSelectionRange);
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("pointerup", handlePointerUp, true);
      window.removeEventListener("resize", updateFromSelectionRange);
      window.removeEventListener("scroll", updateFromSelectionRange, true);
    };
  }, [
    captureSelectionActionSnapshot,
    containerRef,
    inert,
    onQuoteSelection,
    onStartNewSessionFromSelection,
    selectionNewSessionActionEnabled,
    selectionQuoteActionEnabled,
    selectionRichCopyActionEnabled,
    selectionSourceCopyActionEnabled,
    selectionTextCopyActionEnabled,
  ]);

  useEffect(() => {
    if (inert || !onQuoteSelection || !selectionQuoteActionEnabled) {
      return;
    }
    const handleSelectionTyping = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.key.length !== 1 ||
        isInteractiveTarget(event.target)
      ) {
        return;
      }
      if (!applyQuoteFromSelection(event.key)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
    };

    window.addEventListener("keydown", handleSelectionTyping, true);
    return () =>
      window.removeEventListener("keydown", handleSelectionTyping, true);
  }, [
    applyQuoteFromSelection,
    inert,
    isInteractiveTarget,
    onQuoteSelection,
    selectionQuoteActionEnabled,
  ]);

  const activateSelectionAction = useCallback(
    (kind: SelectionActionKind, snapshot: SelectionActionSnapshot): boolean => {
      if (kind === "text") {
        const text = selectionText(snapshot);
        if (!text) return false;
        void writeClipboardText(text);
        return true;
      }
      if (kind === "quote") {
        return applyQuoteAnchors(snapshot.anchors);
      }
      if (kind === "source") {
        const source = selectionSource(snapshot);
        if (!source) {
          return false;
        }
        void writeClipboardText(source);
        return true;
      }
      if (kind === "newSession") {
        if (!onStartNewSessionFromSelection) return false;
        onStartNewSessionFromSelection(newSessionSelectionPrefill(snapshot));
        return true;
      }

      const payload = getSemanticHtmlClipboardPayload(
        snapshot.root,
        snapshot.ranges,
      );
      if (!payload) {
        return false;
      }
      void writeClipboardRichText(payload.html, payload.text);
      return true;
    },
    [applyQuoteAnchors, onStartNewSessionFromSelection],
  );

  const selectionContextMenuActions = useCallback(
    (snapshot: SelectionActionSnapshot): SourceContextMenuAction[] => {
      const actions: SourceContextMenuAction[] = [
        {
          label: t("sessionCopySelectionText" as never),
          onSelect: () => {
            activateSelectionAction("text", snapshot);
          },
        },
        {
          label: t("sessionCopySelectionSource" as never),
          onSelect: () => {
            activateSelectionAction("source", snapshot);
          },
        },
      ];
      if (onQuoteSelection) {
        actions.push({
          label: t("sessionQuoteSelection" as never),
          onSelect: () => {
            activateSelectionAction("quote", snapshot);
          },
        });
      }
      if (onStartNewSessionFromSelection) {
        actions.push({
          label: t("sessionNewSessionFromSelection" as never),
          onSelect: () => {
            activateSelectionAction("newSession", snapshot);
          },
        });
      }
      return actions;
    },
    [
      activateSelectionAction,
      onQuoteSelection,
      onStartNewSessionFromSelection,
      t,
    ],
  );

  useEffect(() => {
    if (inert) return;
    const root = containerRef.current;
    const doc = root?.ownerDocument;
    if (!root || !doc) return;

    const handleContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented || isInteractiveTarget(event.target)) return;
      const snapshot = captureSelectionActionSnapshot();
      if (
        !snapshot ||
        !pointIntersectsSelection(snapshot, event.clientX, event.clientY)
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openSelectionContextMenuAt(
        event.clientX,
        event.clientY,
        doc.activeElement instanceof HTMLElement ? doc.activeElement : null,
        selectionContextMenuActions(snapshot),
      );
    };

    doc.addEventListener("contextmenu", handleContextMenu);
    return () => doc.removeEventListener("contextmenu", handleContextMenu);
  }, [
    captureSelectionActionSnapshot,
    containerRef,
    inert,
    isInteractiveTarget,
    openSelectionContextMenuAt,
    selectionContextMenuActions,
  ]);

  const selectionActionsAreInPortal =
    selectionActions !== null &&
    selectionActions.snapshot.root !== containerRef.current;
  const mobileSelectionActionsTarget =
    selectionActions?.docked && typeof document !== "undefined"
      ? document.querySelector<HTMLElement>(
          "[data-selection-actions-mobile-slot]",
        )
      : null;
  const selectionActionsAreDocked =
    selectionActions?.docked === true && mobileSelectionActionsTarget !== null;
  const enabledSelectionActions: Array<{
    kind: SelectionActionKind;
    label: string;
  }> = [];
  if (selectionTextCopyActionEnabled) {
    enabledSelectionActions.push({
      kind: "text",
      label: t("sessionCopySelectionText" as never),
    });
  }
  if (selectionSourceCopyActionEnabled) {
    enabledSelectionActions.push({
      kind: "source",
      label: t("sessionCopySelectionSource"),
    });
  }
  if (selectionRichCopyActionEnabled) {
    enabledSelectionActions.push({
      kind: "rich",
      label: t("sessionCopySelectionRich"),
    });
  }
  if (selectionQuoteActionEnabled && onQuoteSelection) {
    enabledSelectionActions.push({
      kind: "quote",
      label: t("sessionQuoteSelection"),
    });
  }
  if (selectionNewSessionActionEnabled && onStartNewSessionFromSelection) {
    enabledSelectionActions.push({
      kind: "newSession",
      label: t("sessionNewSessionFromSelection" as never),
    });
  }
  const selectionActionCluster = selectionActions ? (
    <SelectionActionCluster
      docked={selectionActionsAreDocked}
      mobile={selectionActions.mobile}
      placement={selectionActions.side}
      style={
        selectionActionsAreDocked
          ? undefined
          : {
              top: `${selectionActions.top}px`,
              left: `${selectionActions.left}px`,
            }
      }
    >
      {enabledSelectionActions.map(({ kind, label }) => (
        <SelectionActionButton
          key={kind}
          kind={kind}
          label={label}
          onPointerDown={() => {
            selectionActionPointerAppliedRef.current = null;
          }}
          onPointerUp={(event) => {
            if (selectionActions.mobile) {
              event.preventDefault();
              if (activateSelectionAction(kind, selectionActions.snapshot)) {
                selectionActionPointerAppliedRef.current = kind;
              }
            }
          }}
          onClick={() => {
            if (selectionActionPointerAppliedRef.current === kind) {
              selectionActionPointerAppliedRef.current = null;
              return;
            }
            activateSelectionAction(kind, selectionActions.snapshot);
          }}
        />
      ))}
    </SelectionActionCluster>
  ) : null;

  const mobileSelectionActions =
    selectionActionsAreDocked && selectionActionCluster
      ? createPortal(selectionActionCluster, mobileSelectionActionsTarget)
      : null;
  const floatingSelectionActions =
    selectionActions && !selectionActionsAreDocked
      ? selectionActionsAreInPortal
        ? selectionActions.snapshot.root.isConnected
          ? createPortal(selectionActionCluster, selectionActions.snapshot.root)
          : null
        : selectionActionCluster
      : null;

  return {
    alwaysShowQuoteCircles,
    paragraphQuoteCirclesEnabled,
    handleQuoteTextBlock,
    mobileSelectionActions,
    floatingSelectionActions,
    selectionContextMenu,
  };
}

/** Compatibility name for the transcript owner that established this hook. */
export const useMessageListSelectionQuote = useSelectionActions;
