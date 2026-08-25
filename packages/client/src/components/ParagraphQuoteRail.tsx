import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";
import { createCommentAnchor, type CommentAnchor } from "../lib/commentAnchors";
import {
  getMarkdownSnippetForElement,
  getMarkdownSnippetForSubElement,
} from "../lib/markdownSelectionCopy";

const PARAGRAPH_BLOCK_SELECTOR =
  "p, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, table";

function collectTopLevelBlocks(content: HTMLElement): HTMLElement[] {
  const all = Array.from(
    content.querySelectorAll<HTMLElement>(PARAGRAPH_BLOCK_SELECTOR),
  );
  return all.filter((element) => {
    const parentBlock = element.parentElement?.closest(
      PARAGRAPH_BLOCK_SELECTOR,
    );
    return !parentBlock || !content.contains(parentBlock);
  });
}

export function ParagraphQuoteRail({
  alwaysShowQuoteCircle,
  contentRef,
  layoutKey,
  onQuoteBlock,
  paragraphQuoteCirclesEnabled,
  sourceRef,
  surfaceRef,
}: {
  alwaysShowQuoteCircle: boolean;
  contentRef: RefObject<HTMLElement | null>;
  layoutKey: string;
  onQuoteBlock: (anchor: CommentAnchor) => void;
  paragraphQuoteCirclesEnabled: boolean;
  sourceRef: RefObject<HTMLElement | null>;
  surfaceRef: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const paragraphBlocksRef = useRef<HTMLElement[]>([]);
  const [paragraphTargets, setParagraphTargets] = useState<
    { top: number; height: number }[]
  >([]);

  useEffect(() => {
    void layoutKey;
    const content = contentRef.current;
    const surface = surfaceRef.current;
    if (!paragraphQuoteCirclesEnabled || !content || !surface) {
      if (paragraphBlocksRef.current.length > 0) {
        paragraphBlocksRef.current = [];
        setParagraphTargets([]);
      }
      return;
    }

    const measure = () => {
      const blocks = collectTopLevelBlocks(content);
      const surfaceRect = surface.getBoundingClientRect();
      paragraphBlocksRef.current = blocks;
      setParagraphTargets(
        blocks.map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            top: rect.top - surfaceRect.top,
            height: rect.height,
          };
        }),
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [contentRef, layoutKey, paragraphQuoteCirclesEnabled, surfaceRef]);

  const handleQuoteBlock = useCallback(() => {
    const sourceElement = sourceRef.current;
    const contentElement = contentRef.current;
    if (!sourceElement) return;
    const sourceSnippet = getMarkdownSnippetForElement(sourceElement);
    if (!sourceSnippet) return;
    const visibleSnippet =
      contentElement && contentElement !== sourceElement
        ? getMarkdownSnippetForSubElement(sourceElement, contentElement)
        : null;
    onQuoteBlock(
      createCommentAnchor(
        visibleSnippet
          ? {
              ...sourceSnippet,
              range: visibleSnippet.range,
              selectedText: visibleSnippet.selectedText,
            }
          : sourceSnippet,
      ),
    );
  }, [contentRef, onQuoteBlock, sourceRef]);

  const quoteParagraph = useCallback(
    (index: number) => {
      const sourceElement = sourceRef.current;
      const blockElement = paragraphBlocksRef.current[index];
      if (!sourceElement || !blockElement) return;
      const snippet = getMarkdownSnippetForSubElement(
        sourceElement,
        blockElement,
      );
      if (snippet) onQuoteBlock(createCommentAnchor(snippet));
    },
    [onQuoteBlock, sourceRef],
  );

  return (
    <div className="text-block-quote-rail">
      {paragraphQuoteCirclesEnabled && paragraphTargets.length > 0 ? (
        paragraphTargets.map((target, index) => (
          <button
            key={index}
            type="button"
            className={`text-block-quote text-block-quote-paragraph ${alwaysShowQuoteCircle ? "always-visible" : ""}`}
            style={{ top: `${target.top + target.height}px` }}
            onClick={() => quoteParagraph(index)}
            title={t("sessionQuoteBlock")}
            aria-label={t("sessionQuoteBlock")}
          >
            &gt;
          </button>
        ))
      ) : (
        <button
          type="button"
          className={`text-block-quote text-block-quote-fallback ${alwaysShowQuoteCircle ? "always-visible" : ""}`}
          onClick={handleQuoteBlock}
          title={t("sessionQuoteBlock")}
          aria-label={t("sessionQuoteBlock")}
        >
          &gt;
        </button>
      )}
    </div>
  );
}
