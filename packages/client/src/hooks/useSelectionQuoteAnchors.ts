import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  createCommentAnchor,
  type CommentAnchor,
  draftQuoteSignaturesContainAnchor,
  getCommentAnchorRange,
  getDraftQuoteLineSignatures,
  resolveCommentAnchorSource,
} from "../lib/commentAnchors";
import type {
  ComposerDraftChange,
  ComposerDraftSignal,
} from "../lib/composerDraftSignal";
import {
  extractMarkdownSnippetsFromSelection,
  getQuoteSelectionRoot,
} from "../lib/markdownSelectionCopy";

interface UseSelectionQuoteAnchorsOptions {
  containerRef: RefObject<HTMLDivElement | null>;
  composerDraftSignal?: ComposerDraftSignal;
  onQuoteSelection?: (quotedText: string) => string | null;
  quoteClearSignal: number;
}

export interface SelectionQuoteAnchorController {
  anchoredRenderIds: readonly string[];
  applyQuoteAnchors: (
    anchors: readonly CommentAnchor[],
    typedPrefix?: string,
  ) => boolean;
  applyQuoteFromSelection: (typedPrefix?: string) => boolean;
}

export function useSelectionQuoteAnchors({
  containerRef,
  composerDraftSignal,
  onQuoteSelection,
  quoteClearSignal,
}: UseSelectionQuoteAnchorsOptions): SelectionQuoteAnchorController {
  const quoteInsertionDraftRef = useRef<string | null>(null);
  const commentAnchorsRef = useRef<readonly CommentAnchor[]>([]);
  const [anchoredRenderIds, setAnchoredRenderIds] = useState<readonly string[]>(
    [],
  );
  const commentHighlightObserverRef = useRef<MutationObserver | null>(null);
  const draftSubscriptionRef = useRef<(() => void) | null>(null);
  const composerDraftSignalRef = useRef(composerDraftSignal);
  const reconcileDraftChangeRef = useRef<(change: ComposerDraftChange) => void>(
    () => {},
  );

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
        .filter((anchor) =>
          resolveCommentAnchorSource(anchor, containerRef.current),
        )
        .map(getCommentAnchorRange)
        .filter((range): range is Range => range !== null);
      if (ranges.length === 0) {
        CSS.highlights.delete("comment-tint");
        return;
      }
      CSS.highlights.set("comment-tint", new Highlight(...ranges));
    },
    [containerRef],
  );

  const releaseDraftSubscription = useCallback(() => {
    draftSubscriptionRef.current?.();
    draftSubscriptionRef.current = null;
  }, []);

  const releaseCommentHighlightObserver = useCallback(() => {
    commentHighlightObserverRef.current?.disconnect();
    commentHighlightObserverRef.current = null;
  }, []);

  const refreshCommentHighlightObserver = useCallback(
    (anchors: readonly CommentAnchor[]) => {
      releaseCommentHighlightObserver();
      const sourceElements = Array.from(
        new Set(
          anchors
            .map((anchor) => anchor.sourceElement)
            .filter((element) => element.isConnected),
        ),
      );
      const sourceElement = sourceElements[0];
      const MutationObserverConstructor =
        sourceElement?.ownerDocument.defaultView?.MutationObserver;
      if (!sourceElement || !MutationObserverConstructor) {
        return;
      }
      const observer = new MutationObserverConstructor(() => {
        applyCommentHighlight(commentAnchorsRef.current);
      });
      for (const element of sourceElements) {
        observer.observe(element, {
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
      commentHighlightObserverRef.current = observer;
    },
    [applyCommentHighlight, releaseCommentHighlightObserver],
  );

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
      setAnchoredRenderIds(
        Array.from(
          new Set(
            next
              .map((anchor) => anchor.renderId)
              .filter((id): id is string => id !== undefined),
          ),
        ),
      );
      applyCommentHighlight(next);
      refreshCommentHighlightObserver(next);
      if (previous.length === 0 && next.length > 0) {
        refreshDraftSubscription();
      } else if (previous.length > 0 && next.length === 0) {
        releaseDraftSubscription();
      }
    },
    [
      applyCommentHighlight,
      refreshCommentHighlightObserver,
      refreshDraftSubscription,
      releaseDraftSubscription,
    ],
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
      releaseCommentHighlightObserver();
      applyCommentHighlight([]);
    },
    [
      applyCommentHighlight,
      releaseCommentHighlightObserver,
      releaseDraftSubscription,
    ],
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

  useEffect(() => {
    if (quoteClearSignal > 0) {
      updateCommentAnchors([]);
    }
  }, [quoteClearSignal, updateCommentAnchors]);

  return { anchoredRenderIds, applyQuoteAnchors, applyQuoteFromSelection };
}
