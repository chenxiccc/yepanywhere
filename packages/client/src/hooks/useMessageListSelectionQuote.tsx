import { type ReactNode, type RefObject, useCallback } from "react";
import type { CommentAnchor } from "../lib/commentAnchors";
import type { ComposerDraftSignal } from "../lib/composerDraftSignal";
import { useQuoteReplyButtonMode } from "./useQuoteReplyButtonMode";
import { useSelectionActionPresentation } from "./useSelectionActionPresentation";
import { useSelectionQuoteAnchors } from "./useSelectionQuoteAnchors";

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
  anchoredRenderIds: readonly string[];
  alwaysShowQuoteCircles: boolean;
  paragraphQuoteCirclesEnabled: boolean;
  handleQuoteTextBlock: (anchor: CommentAnchor) => void;
  mobileSelectionActions: ReactNode;
  floatingSelectionActions: ReactNode;
  selectionContextMenu: ReactNode;
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
  const { quoteReplyButtonMode } = useQuoteReplyButtonMode();
  const quoteAnchors = useSelectionQuoteAnchors({
    containerRef,
    composerDraftSignal,
    onQuoteSelection,
    quoteClearSignal,
  });
  const selectionActions = useSelectionActionPresentation({
    ...quoteAnchors,
    containerRef,
    inert,
    isInteractiveTarget,
    onQuoteSelection,
    onStartNewSessionFromSelection,
  });
  const handleQuoteTextBlock = useCallback(
    (anchor: CommentAnchor) => {
      if (quoteAnchors.applyQuoteAnchors([anchor])) {
        selectionActions.dismiss();
      }
    },
    [quoteAnchors.applyQuoteAnchors, selectionActions.dismiss],
  );

  return {
    anchoredRenderIds: quoteAnchors.anchoredRenderIds,
    alwaysShowQuoteCircles: quoteReplyButtonMode === "paragraph-always",
    paragraphQuoteCirclesEnabled: quoteReplyButtonMode !== "block",
    handleQuoteTextBlock,
    mobileSelectionActions: selectionActions.mobileSelectionActions,
    floatingSelectionActions: selectionActions.floatingSelectionActions,
    selectionContextMenu: selectionActions.selectionContextMenu,
  };
}

/** Compatibility name for the transcript owner that established this hook. */
export const useMessageListSelectionQuote = useSelectionActions;
