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
  createCommentAnchor,
  type CommentAnchor,
  draftQuoteSignaturesContainAnchor,
  type DraftTextChangeMetadata,
  getCommentAnchorRange,
  getDraftQuoteLineSignatures,
} from "../lib/commentAnchors";
import {
  copyMarkdownSelectionToClipboard,
  extractMarkdownSnippetsFromSelection,
  getQuoteSelectionRoot,
  getQuoteSelectionRootForTarget,
} from "../lib/markdownSelectionCopy";
import { useI18n } from "../i18n";
import { useQuoteReplyButtonMode } from "./useQuoteReplyButtonMode";

const SELECTION_QUOTE_BUTTON_SIZE_PX = 30;
const SELECTION_QUOTE_BUTTON_GAP_PX = 8;
const TRANSCRIPT_SELECTION_ACTIVE_CLASS = "session-transcript-selection-active";

type SelectionQuoteButtonState =
  | {
      placement: "floating";
      top: number;
      left: number;
      anchors: readonly CommentAnchor[];
      root: HTMLElement;
    }
  | {
      placement: "mobile";
      anchors: readonly CommentAnchor[];
      root: HTMLElement;
    };

interface UseMessageListSelectionQuoteOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  inert: boolean;
  onQuoteSelection?: (quotedText: string) => string | null;
  getComposerDraft?: () => string;
  composerDraft: string;
  composerDraftChange?: DraftTextChangeMetadata;
  quoteClearSignal: number;
  followButtonVisible: boolean;
  isInteractiveTarget: (target: EventTarget | null) => boolean;
}

interface MessageListSelectionQuoteState {
  alwaysShowQuoteCircles: boolean;
  paragraphQuoteCirclesEnabled: boolean;
  handleQuoteTextBlock: (anchor: CommentAnchor) => void;
  mobileSelectionQuoteButton: ReactNode;
  floatingSelectionQuoteButton: ReactNode;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function shouldShieldTranscriptSelection(win: Window): boolean {
  return win.matchMedia?.("(pointer: coarse)").matches === true;
}

export function useMessageListSelectionQuote({
  containerRef,
  inert,
  onQuoteSelection,
  getComposerDraft,
  composerDraft,
  composerDraftChange,
  quoteClearSignal,
  followButtonVisible,
  isInteractiveTarget,
}: UseMessageListSelectionQuoteOptions): MessageListSelectionQuoteState {
  const selectionPointerStartRef = useRef<{ clientY: number } | null>(null);
  const selectionQuotePointerAppliedRef = useRef(false);
  const quoteInsertionDraftRef = useRef<string | null>(null);
  const [commentAnchors, setCommentAnchors] = useState<
    readonly CommentAnchor[]
  >([]);
  const [selectionQuoteButton, setSelectionQuoteButton] =
    useState<SelectionQuoteButtonState | null>(null);
  const { quoteReplyButtonMode } = useQuoteReplyButtonMode();
  const alwaysShowQuoteCircles = quoteReplyButtonMode === "paragraph-always";
  const paragraphQuoteCirclesEnabled = quoteReplyButtonMode !== "block";
  const { t } = useI18n();

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
      setCommentAnchors((previous) => [...previous, ...anchors]);
      containerRef.current?.ownerDocument.getSelection()?.removeAllRanges();
      setSelectionQuoteButton(null);
      return true;
    },
    [containerRef, onQuoteSelection],
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

  useEffect(() => {
    if (commentAnchors.length === 0) {
      return;
    }
    const insertionDraft = quoteInsertionDraftRef.current;
    if (
      insertionDraft === null &&
      composerDraftChange?.mayAffectQuoteAnchors === false
    ) {
      return;
    }
    const draft = insertionDraft ?? getComposerDraft?.() ?? composerDraft;
    quoteInsertionDraftRef.current = null;
    const draftSignatures = getDraftQuoteLineSignatures(draft);
    setCommentAnchors((previous) => {
      const next = previous.filter((anchor) =>
        draftQuoteSignaturesContainAnchor(draftSignatures, anchor),
      );
      return next.length === previous.length ? previous : next;
    });
  }, [
    commentAnchors.length,
    composerDraft,
    composerDraftChange,
    getComposerDraft,
  ]);

  useEffect(() => {
    if (quoteClearSignal > 0) {
      setCommentAnchors([]);
    }
  }, [quoteClearSignal]);

  useEffect(() => {
    if (
      typeof CSS === "undefined" ||
      !("highlights" in CSS) ||
      typeof Highlight === "undefined"
    ) {
      return;
    }

    if (commentAnchors.length === 0) {
      CSS.highlights.delete("comment-tint");
      return;
    }

    const ranges = commentAnchors
      .map(getCommentAnchorRange)
      .filter((range): range is Range => range !== null);
    if (ranges.length === 0) {
      CSS.highlights.delete("comment-tint");
      return;
    }

    const highlight = new Highlight(...ranges);
    CSS.highlights.set("comment-tint", highlight);
    return () => {
      CSS.highlights.delete("comment-tint");
    };
  }, [commentAnchors]);

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
    if (inert || !onQuoteSelection) {
      setSelectionQuoteButton(null);
      return;
    }

    const updateFloatingQuoteButton = (pointerEnd?: {
      clientX: number;
      clientY: number;
      placeBelow?: boolean;
    }) => {
      const root = containerRef.current;
      const selection = root?.ownerDocument.getSelection();
      if (
        !root ||
        !selection ||
        selection.isCollapsed ||
        selection.rangeCount === 0
      ) {
        setSelectionQuoteButton(null);
        return;
      }

      const selectionRoot = getQuoteSelectionRoot(root, selection);
      if (!selectionRoot) {
        setSelectionQuoteButton(null);
        return;
      }
      const anchors =
        extractMarkdownSnippetsFromSelection(selectionRoot).map(
          createCommentAnchor,
        );
      if (anchors.length === 0) {
        setSelectionQuoteButton(null);
        return;
      }

      const win = root.ownerDocument.defaultView ?? window;
      if (shouldShieldTranscriptSelection(win)) {
        setSelectionQuoteButton({
          placement: "mobile",
          anchors,
          root: selectionRoot,
        });
        return;
      }

      const range = selection.getRangeAt(selection.rangeCount - 1);
      const rect =
        pointerEnd || typeof range.getBoundingClientRect !== "function"
          ? null
          : range.getBoundingClientRect();
      if (!pointerEnd && (!rect || (rect.width === 0 && rect.height === 0))) {
        setSelectionQuoteButton(null);
        return;
      }
      const rootRect = selectionRoot.getBoundingClientRect();
      const clientX = pointerEnd?.clientX ?? rect?.right ?? rootRect.left;
      const clientY = pointerEnd?.clientY ?? rect?.top ?? rootRect.top;
      const maxTop = Math.max(
        0,
        selectionRoot.clientHeight - SELECTION_QUOTE_BUTTON_SIZE_PX,
      );
      const maxLeft = Math.max(
        0,
        selectionRoot.clientWidth - SELECTION_QUOTE_BUTTON_SIZE_PX,
      );
      setSelectionQuoteButton({
        placement: "floating",
        anchors,
        root: selectionRoot,
        top: clampNumber(
          pointerEnd?.placeBelow
            ? clientY - rootRect.top + SELECTION_QUOTE_BUTTON_GAP_PX
            : clientY -
                rootRect.top -
                SELECTION_QUOTE_BUTTON_SIZE_PX -
                SELECTION_QUOTE_BUTTON_GAP_PX,
          0,
          maxTop,
        ),
        left: clampNumber(
          clientX - rootRect.left + SELECTION_QUOTE_BUTTON_GAP_PX,
          0,
          maxLeft,
        ),
      });
    };
    const handlePointerDown = (event: PointerEvent) => {
      const root = containerRef.current;
      if (!root || !getQuoteSelectionRootForTarget(root, event.target)) {
        selectionPointerStartRef.current = null;
        return;
      }
      selectionPointerStartRef.current = { clientY: event.clientY };
    };
    const handlePointerUp = (event: PointerEvent) => {
      const start = selectionPointerStartRef.current;
      selectionPointerStartRef.current = null;
      window.setTimeout(() => {
        updateFloatingQuoteButton({
          clientX: event.clientX,
          clientY: event.clientY,
          placeBelow: start ? event.clientY > start.clientY : false,
        });
      }, 0);
    };
    const updateFromSelectionRange = () => updateFloatingQuoteButton();

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
  }, [containerRef, inert, onQuoteSelection]);

  useEffect(() => {
    if (inert || !onQuoteSelection) {
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
  }, [applyQuoteFromSelection, inert, isInteractiveTarget, onQuoteSelection]);

  const mobileSelectionQuoteButtonTarget =
    selectionQuoteButton?.placement === "mobile" &&
    selectionQuoteButton.root.isConnected &&
    typeof document !== "undefined"
      ? selectionQuoteButton.root === containerRef.current
        ? document.querySelector<HTMLElement>(".session-input-inner")
        : selectionQuoteButton.root
      : null;
  const selectionQuoteButtonIsInPortal =
    selectionQuoteButton !== null &&
    selectionQuoteButton.root !== containerRef.current;
  const selectionQuoteButtonElement = selectionQuoteButton ? (
    <button
      type="button"
      className={[
        "selection-quote-button",
        selectionQuoteButton.placement === "mobile"
          ? "selection-quote-button--mobile"
          : "",
        selectionQuoteButton.placement === "mobile" && followButtonVisible
          ? "selection-quote-button--mobile-with-follow"
          : "",
        selectionQuoteButton.placement === "mobile" &&
        selectionQuoteButtonIsInPortal
          ? "selection-quote-button--mobile-modal"
          : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={
        selectionQuoteButton.placement === "floating"
          ? {
              top: `${selectionQuoteButton.top}px`,
              left: `${selectionQuoteButton.left}px`,
            }
          : undefined
      }
      onPointerDown={(event) => {
        if (selectionQuoteButton.placement === "mobile") {
          selectionQuotePointerAppliedRef.current = false;
          event.preventDefault();
        }
      }}
      onPointerUp={(event) => {
        if (selectionQuoteButton.placement === "mobile") {
          event.preventDefault();
          selectionQuotePointerAppliedRef.current = applyQuoteAnchors(
            selectionQuoteButton.anchors,
          );
        }
      }}
      onMouseDown={(event) => event.preventDefault()}
      onClick={() => {
        if (
          selectionQuoteButton.placement === "mobile" &&
          selectionQuotePointerAppliedRef.current
        ) {
          selectionQuotePointerAppliedRef.current = false;
          return;
        }
        applyQuoteAnchors(selectionQuoteButton.anchors);
      }}
      aria-label={t("sessionQuoteSelection")}
      title={t("sessionQuoteSelection")}
    >
      <span aria-hidden="true">&gt;</span>
      {selectionQuoteButton.placement === "mobile" && (
        <span>{t("sessionQuoteSelectionShort")}</span>
      )}
    </button>
  ) : null;

  const mobileSelectionQuoteButton =
    selectionQuoteButton?.placement === "mobile" && selectionQuoteButtonElement
      ? mobileSelectionQuoteButtonTarget
        ? createPortal(
            selectionQuoteButtonElement,
            mobileSelectionQuoteButtonTarget,
          )
        : selectionQuoteButtonIsInPortal
          ? null
          : selectionQuoteButtonElement
      : null;
  const floatingSelectionQuoteButton =
    selectionQuoteButton?.placement === "floating"
      ? selectionQuoteButtonIsInPortal
        ? selectionQuoteButton.root.isConnected
          ? createPortal(selectionQuoteButtonElement, selectionQuoteButton.root)
          : null
        : selectionQuoteButtonElement
      : null;

  return {
    alwaysShowQuoteCircles,
    paragraphQuoteCirclesEnabled,
    handleQuoteTextBlock,
    mobileSelectionQuoteButton,
    floatingSelectionQuoteButton,
  };
}
