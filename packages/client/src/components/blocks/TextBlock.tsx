import {
  memo,
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useRenderModeToggle } from "../../contexts/RenderModeContext";
import {
  createCommentAnchor,
  type CommentAnchor,
} from "../../lib/commentAnchors";
import { useStreamingMarkdownContext } from "../../contexts/StreamingMarkdownContext";
import { useStreamingMarkdown } from "../../hooks/useStreamingMarkdown";
import { useI18n } from "../../i18n";
import {
  getMarkdownSnippetForElement,
  getMarkdownSnippetForSubElement,
  registerMarkdownCopySource,
} from "../../lib/markdownSelectionCopy";
import { FileViewerModal } from "../FilePathLink";
import {
  LocalFileModal,
  LocalMediaModal,
  useLocalMediaInlinePreviews,
  useLocalResourceClick,
} from "../LocalMediaModal";
import { renderFixedFontMath } from "../ui/FixedFontMathToggle";
import { RenderModeGlyph } from "../ui/RenderModeGlyph";
import { useTurnImageGalleryNavigation } from "../TurnImageGallery";
import { useGlossaryArtifact } from "../../contexts/GlossaryContext";
import { annotateGlossaryHtml } from "../../lib/glossary/annotateGlossaryHtml";
import {
  findTurnInlineImageAnchor,
  getTurnInlineImageTargetForTarget,
} from "../../lib/turnInlineMedia";

const EMPTY_LOCAL_MATH_PREVIEW = { html: "", changed: false };

// Rendered block-level elements that get their own per-paragraph quote circle.
const PARAGRAPH_BLOCK_SELECTOR =
  "p, ul, ol, blockquote, pre, h1, h2, h3, h4, h5, h6, table";

/**
 * Top-level rendered blocks inside the copy-source content — paragraphs, lists,
 * etc. — skipping blocks nested inside another block (e.g. a `<p>` inside an
 * `<li>`), so each gets exactly one quote circle.
 */
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

function htmlToText(html: string): string {
  if (typeof document === "undefined") {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content.textContent ?? "";
}

const RenderedHtmlIsland = memo(function RenderedHtmlIsland({
  artifact,
  className,
  html,
}: {
  artifact?: import("@yep-anywhere/shared").GlossaryArtifact;
  className?: string;
  html: string;
}) {
  const renderedHtml = useMemo(() => {
    return annotateGlossaryHtml(html, artifact).html;
  }, [artifact, html]);
  return (
    <div
      className={className}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered or local trusted HTML
      dangerouslySetInnerHTML={{ __html: renderedHtml }}
    />
  );
});

interface Props {
  text: string;
  isStreaming?: boolean;
  /** Pre-rendered HTML from server (for completed messages) */
  augmentHtml?: string;
  onQuoteBlock?: (anchor: CommentAnchor) => void;
  alwaysShowQuoteCircle?: boolean;
  paragraphQuoteCirclesEnabled?: boolean;
  renderItemId?: string;
}

export const TextBlock = memo(function TextBlock({
  text,
  isStreaming = false,
  augmentHtml,
  onQuoteBlock,
  alwaysShowQuoteCircle = false,
  paragraphQuoteCirclesEnabled = true,
  renderItemId,
}: Props) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [galleryActionHost, setGalleryActionHost] =
    useState<HTMLElement | null>(null);
  const copySourceRef = useRef<HTMLDivElement>(null);
  const textBlockRef = useRef<HTMLDivElement>(null);
  const paragraphBlocksRef = useRef<HTMLElement[]>([]);
  const [paragraphTargets, setParagraphTargets] = useState<
    { top: number; height: number }[]
  >([]);
  const localMathPreview = useMemo(
    () => (isStreaming ? EMPTY_LOCAL_MATH_PREVIEW : renderFixedFontMath(text)),
    [isStreaming, text],
  );
  const glossary = useGlossaryArtifact();
  const glossaryArtifact =
    glossary.state === "ready" && glossary.result?.status === "ready"
      ? glossary.result.artifact
      : undefined;
  const transformGlossaryHtml = useCallback(
    (html: string) => annotateGlossaryHtml(html, glossaryArtifact).html,
    [glossaryArtifact],
  );
  const serverMarkdownChanged = useMemo(() => {
    if (!augmentHtml) return false;
    return htmlToText(augmentHtml).trim() !== text.trim();
  }, [augmentHtml, text]);

  // Streaming markdown hook for server-rendered content
  const streamingMarkdown = useStreamingMarkdown({
    transformHtml: transformGlossaryHtml,
  });
  const streamingContext = useStreamingMarkdownContext();

  // Track whether we're actively using streaming markdown (received at least one augment)
  const [useStreamingContent, setUseStreamingContent] = useState(false);

  // Register with context when streaming and context is available
  useEffect(() => {
    if (!isStreaming || !streamingContext) {
      // Reset streaming state when not streaming
      // (HTML is captured to markdownAugments before component remounts)
      if (!isStreaming) {
        setUseStreamingContent(false);
        streamingMarkdown.reset();
      }
      return;
    }

    // Register handlers with the context
    const unregister = streamingContext.registerStreamingHandler({
      onAugment: (augment) => {
        // Mark that we're using streaming content on first augment
        setUseStreamingContent((current) => (current ? current : true));
        streamingMarkdown.onAugment(augment);
      },
      onPending: streamingMarkdown.onPending,
      onStreamEnd: streamingMarkdown.onStreamEnd,
      captureHtml: streamingMarkdown.captureHtml,
    });

    return unregister;
  }, [
    isStreaming,
    streamingContext,
    streamingMarkdown.captureHtml,
    streamingMarkdown.onAugment,
    streamingMarkdown.onPending,
    streamingMarkdown.onStreamEnd,
    streamingMarkdown.reset,
  ]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 3000);
    } catch (err) {
      console.error("Failed to copy text:", err);
    }
  }, [text]);

  const handleQuoteBlock = useCallback(() => {
    const element = copySourceRef.current;
    if (!element || !onQuoteBlock) {
      return;
    }
    const snippet = getMarkdownSnippetForElement(element);
    if (!snippet) {
      return;
    }
    onQuoteBlock(createCommentAnchor(snippet));
  }, [onQuoteBlock]);

  const quoteParagraph = useCallback(
    (index: number) => {
      const sourceElement = copySourceRef.current;
      const blockElement = paragraphBlocksRef.current[index];
      if (!sourceElement || !blockElement || !onQuoteBlock) {
        return;
      }
      const snippet = getMarkdownSnippetForSubElement(
        sourceElement,
        blockElement,
      );
      if (!snippet) {
        return;
      }
      onQuoteBlock(createCommentAnchor(snippet));
    },
    [onQuoteBlock],
  );

  useEffect(() => {
    const element = copySourceRef.current;
    if (!element) {
      return;
    }

    return registerMarkdownCopySource(element, text);
  }, [text]);

  const {
    modal,
    localFileModal,
    projectFileModal,
    handleClick,
    handleContextMenu,
    closeModal,
    closeLocalFileModal,
    closeProjectFileModal,
    contextMenuElement,
  } = useLocalResourceClick();
  const turnImageGallery = useTurnImageGalleryNavigation();
  useLocalMediaInlinePreviews(copySourceRef, undefined, undefined, {
    suppressAutomaticImages: turnImageGallery?.available === true,
  });
  const handleContentClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const content = copySourceRef.current;
      const galleryImageTarget =
        content && renderItemId && turnImageGallery?.available
          ? getTurnInlineImageTargetForTarget(
              content,
              renderItemId,
              event.target,
            )
          : null;
      if (
        galleryImageTarget &&
        turnImageGallery?.candidateIds.has(galleryImageTarget.id)
      ) {
        event.preventDefault();
        event.stopPropagation();
        if (galleryImageTarget.kind === "link") {
          turnImageGallery.openImage(galleryImageTarget.id);
        } else if (turnImageGallery.active) {
          turnImageGallery.collapse();
        } else {
          turnImageGallery.activate(galleryImageTarget.id);
        }
        return;
      }
      handleClick(event);
    },
    [handleClick, renderItemId, turnImageGallery],
  );

  const showStreamingContent = isStreaming && useStreamingContent;
  const canToggleRendered = serverMarkdownChanged || localMathPreview.changed;
  const { showRendered, toggleLocalMode } = useRenderModeToggle(
    canToggleRendered,
    {
      participateInGlobalMode: false,
      resetDependencies: [
        isStreaming,
        isStreaming ? "" : text,
        augmentHtml ?? "",
      ],
    },
  );

  // Always render streaming container when isStreaming so refs are attached
  // before first augment arrives. Hidden until useStreamingContent becomes true.
  const renderStreamingContainer = isStreaming;
  const paragraphLayoutKey = [showRendered, text, augmentHtml ?? ""].join("\0");
  const galleryActionTarget = turnImageGallery?.actionTarget ?? null;
  const galleryActive = turnImageGallery?.active === true;

  useEffect(() => {
    const content = copySourceRef.current;
    if (
      !content ||
      !showRendered ||
      showStreamingContent ||
      !renderItemId ||
      !turnImageGallery?.available
    ) {
      return;
    }

    const toggles = content.querySelectorAll<HTMLButtonElement>(
      "button.local-media-inline-toggle[data-media-type='image']",
    );
    for (const toggle of toggles) {
      const target = getTurnInlineImageTargetForTarget(
        content,
        renderItemId,
        toggle,
      );
      if (!target || !turnImageGallery.candidateIds.has(target.id)) {
        continue;
      }
      const label = turnImageGallery.candidateLabels.get(target.id) ?? "";
      const controlLabel = galleryActive
        ? t("turnImageGalleryCollapse")
        : t("turnImageGalleryExpandAt", { label });
      toggle.dataset.expanded = String(galleryActive);
      toggle.setAttribute("aria-expanded", String(galleryActive));
      toggle.setAttribute("aria-label", controlLabel);
      toggle.title = controlLabel;
      toggle.textContent = galleryActive ? "−" : "+";
    }
  }, [
    galleryActive,
    renderItemId,
    showRendered,
    showStreamingContent,
    t,
    turnImageGallery,
  ]);

  useLayoutEffect(() => {
    const content = copySourceRef.current;
    let host: HTMLSpanElement | null = null;
    if (
      content &&
      showRendered &&
      !showStreamingContent &&
      renderItemId &&
      galleryActionTarget?.sourceItemId === renderItemId
    ) {
      const anchor = findTurnInlineImageAnchor(
        content,
        galleryActionTarget.sourceIndex,
      );
      const group = anchor?.closest(".local-media-link-group");
      if (group) {
        host = document.createElement("span");
        host.className = "turn-image-gallery-inline-action-host";
        group.append(host);
      }
    }
    setGalleryActionHost(host);
    return () => host?.remove();
  }, [galleryActionTarget, renderItemId, showRendered, showStreamingContent]);

  // Measure each rendered top-level block so a per-paragraph quote circle can
  // sit at its end. Skipped while streaming (paragraph boundaries are still
  // moving); re-measured on reflow via ResizeObserver.
  useEffect(() => {
    void paragraphLayoutKey;
    const content = copySourceRef.current;
    const block = textBlockRef.current;
    if (
      !onQuoteBlock ||
      !paragraphQuoteCirclesEnabled ||
      !content ||
      !block ||
      showStreamingContent
    ) {
      // Clear without churning state when already empty: the no-quote path must
      // render identically to a TextBlock without quote circles. A stray extra
      // render here disturbs other post-render content effects (inline media).
      if (paragraphBlocksRef.current.length > 0) {
        paragraphBlocksRef.current = [];
        setParagraphTargets([]);
      }
      return;
    }

    const measure = () => {
      const blocks = collectTopLevelBlocks(content);
      const blockRect = block.getBoundingClientRect();
      paragraphBlocksRef.current = blocks;
      setParagraphTargets(
        blocks.map((element) => {
          const rect = element.getBoundingClientRect();
          return { top: rect.top - blockRect.top, height: rect.height };
        }),
      );
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [
    onQuoteBlock,
    paragraphLayoutKey,
    paragraphQuoteCirclesEnabled,
    showStreamingContent,
  ]);

  return (
    <div
      ref={textBlockRef}
      className={`text-block text-block-assistant timeline-item${isStreaming ? " streaming" : ""}`}
      data-turn-image-source-id={renderItemId}
    >
      {onQuoteBlock && (
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
      )}
      <div className="text-block-actions">
        {canToggleRendered && (
          <button
            type="button"
            className={`text-block-toggle ${showRendered ? "is-rendered" : ""}`}
            onClick={toggleLocalMode}
            title={showRendered ? "Show source" : "Show rendered"}
            aria-label={showRendered ? "Show source" : "Show rendered"}
            aria-pressed={showRendered}
          >
            <RenderModeGlyph />
          </button>
        )}
        <button
          type="button"
          className={`text-block-copy ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy markdown"}
          aria-label={copied ? "Copied!" : "Copy markdown"}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: click is delegated to media/link elements inside rendered markdown */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: keyboard activation remains on the descendant links/controls */}
      <div
        ref={copySourceRef}
        className="text-block-content"
        onClick={handleContentClick}
        onContextMenu={handleContextMenu}
      >
        {/* Always render streaming elements when streaming so refs are ready for augments */}
        {renderStreamingContainer && (
          <div
            style={
              showStreamingContent && showRendered
                ? undefined
                : { display: "none" }
            }
          >
            <div
              ref={streamingMarkdown.containerRef}
              className="streaming-blocks"
            />
            <span
              ref={streamingMarkdown.pendingRef}
              className="streaming-pending"
            />
          </div>
        )}

        {/* Show fallback content when not actively streaming */}
        {!showStreamingContent &&
          (showRendered && augmentHtml ? (
            <RenderedHtmlIsland
              artifact={glossaryArtifact}
              html={augmentHtml}
            />
          ) : showRendered && localMathPreview.changed ? (
            <RenderedHtmlIsland
              artifact={glossaryArtifact}
              className="text-block-local-rendered"
              html={localMathPreview.html}
            />
          ) : (
            <pre className="text-block-source">
              <code>{text}</code>
            </pre>
          ))}
      </div>
      {galleryActionHost
        ? createPortal(
            <button
              type="button"
              className="turn-image-gallery-inline-action"
              aria-expanded={galleryActive}
              aria-label={t(
                galleryActive
                  ? "turnImageGalleryCollapse"
                  : "turnImageGalleryExpand",
              )}
              title={t(
                galleryActive
                  ? "turnImageGalleryCollapse"
                  : "turnImageGalleryExpand",
              )}
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                if (galleryActive) {
                  turnImageGallery?.collapse();
                } else {
                  turnImageGallery?.show();
                }
              }}
            >
              <span aria-hidden="true">{galleryActive ? "−" : "+"}</span>
              {t("turnImageGalleryShow")}
            </button>,
            galleryActionHost,
          )
        : null}

      {modal && (
        <LocalMediaModal
          path={modal.path}
          mediaType={modal.mediaType}
          onClose={closeModal}
        />
      )}

      {localFileModal && (
        <LocalFileModal
          resource={localFileModal.resource}
          initialPresentation={localFileModal.initialPresentation}
          onClose={closeLocalFileModal}
        />
      )}

      {projectFileModal && (
        <FileViewerModal
          projectId={projectFileModal.projectId}
          filePath={projectFileModal.filePath}
          lineNumber={projectFileModal.lineNumber}
          lineEnd={projectFileModal.lineEnd}
          initialPresentation={projectFileModal.initialPresentation}
          onClose={closeProjectFileModal}
        />
      )}
      {contextMenuElement}
    </div>
  );
});

function CopyIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5" y="5" width="9" height="9" rx="1.5" />
      <path d="M11 5V3.5A1.5 1.5 0 0 0 9.5 2H3.5A1.5 1.5 0 0 0 2 3.5v6A1.5 1.5 0 0 0 3.5 11H5" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 8.5L6.5 12L13 4" />
    </svg>
  );
}
