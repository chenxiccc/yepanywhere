import type {
  GitDiffPreviewSkipped,
  GitDiffResult,
  GitFileChange,
  PatchHunk,
  ReviewCommentRevision,
} from "@yep-anywhere/shared";
import {
  forwardRef,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { MarkdownPreview } from "../components/MarkdownPreview";
import { Modal } from "../components/ui/Modal";
import { useDiffViewMode } from "../hooks/useDiffViewMode";
import { type DiffViewMode, resolveDiffViewMode } from "../lib/diffSideBySide";
import { DiffCommentLayer } from "./DiffCommentLayer";
import { SideBySideDiff } from "./SideBySideDiff";

const GIT_DIFF_MAX_RENDERED_HTML_CHARS = 1_000_000;

type TranslationFn = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export interface GitDiffViewState {
  showFullContext?: boolean;
  showMarkdownPreview?: boolean;
}

interface GitDiffPreviewRetentionProps {
  retainedDiffView?: GitDiffViewState;
  onRetainDiffView?: (fileKey: string, view: GitDiffViewState) => void;
}

interface DiffPaneHeader {
  title: string;
  path: string;
  actions?: ReactNode;
}

export interface GitDiffPreviewHandle {
  /** Advance to the next rendered diff hunk, wrapping at the end. */
  jumpToNextHunk: () => boolean;
}

interface GitDiffPreviewProps extends GitDiffPreviewRetentionProps {
  file: GitFileChange | null;
  fileKey: string | null;
  projectId: string;
  source?: GitDiffSource;
  /** Actions for the selected file, shown in the pane header (the file banner). */
  headerActions?: ReactNode;
  retainedScrollTop?: number;
  onRetainScrollTop?: (fileKey: string, scrollTop: number) => void;
  t: TranslationFn;
}

/**
 * Which revision a diff pane shows: the working tree (an `uncommitted`
 * comment anchor) or a specific commit (a `sha` anchor). The commit browser
 * reuses this whole diff+comment stack by passing `{ kind: "commit", sha }`,
 * so a comment left on a commit diff flows through the exact same
 * relocation/compose pipeline as a working-tree comment.
 */
export type GitDiffSource =
  | { kind: "worktree" }
  | { kind: "working-tree-history" }
  | { kind: "commit"; sha: string };

const WORKTREE_SOURCE: GitDiffSource = { kind: "worktree" };
const WORKING_TREE_HISTORY_SOURCE: GitDiffSource = {
  kind: "working-tree-history",
};

/**
 * Rebuild a source from its primitives. Effects depend on (kind, sha) rather
 * than the source object, whose identity changes every render.
 */
function sourceFromPrimitives(
  kind: GitDiffSource["kind"],
  sha: string,
): GitDiffSource {
  return kind === "commit"
    ? { kind: "commit", sha }
    : kind === "working-tree-history"
      ? WORKING_TREE_HISTORY_SOURCE
      : WORKTREE_SOURCE;
}

function fetchDiffForSource(
  projectId: string,
  file: GitFileChange,
  source: GitDiffSource,
  fullContext?: boolean,
): Promise<GitDiffResult> {
  if (source.kind === "commit") {
    return api.getGitCommitDiff(projectId, {
      sha: source.sha,
      path: file.path,
      status: file.status,
      ...(file.origPath ? { origPath: file.origPath } : {}),
      fullContext,
    });
  }
  return api.getGitDiff(projectId, {
    path: file.path,
    staged: file.staged,
    status: file.status,
    ...(source.kind === "working-tree-history"
      ? {
          againstHead: true,
          ...(file.origPath ? { origPath: file.origPath } : {}),
        }
      : {}),
    fullContext,
  });
}

function commentRevisionForSource(
  source: GitDiffSource,
): ReviewCommentRevision | undefined {
  return source.kind === "commit"
    ? { kind: "sha", sha: source.sha }
    : undefined;
}

export const GitDiffPreview = forwardRef<
  GitDiffPreviewHandle,
  GitDiffPreviewProps
>(function GitDiffPreview(
  {
    file,
    fileKey,
    projectId,
    source = WORKTREE_SOURCE,
    headerActions,
    retainedScrollTop,
    retainedDiffView,
    onRetainScrollTop,
    onRetainDiffView,
    t,
  },
  ref,
) {
  const fileName = file ? file.path.split("/").pop() || file.path : null;
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const jumpToNextHunkRef = useRef<(() => boolean) | null>(null);
  const handleJumpHandlerChange = useCallback(
    (handler: (() => boolean) | null) => {
      jumpToNextHunkRef.current = handler;
    },
    [],
  );

  useImperativeHandle(
    ref,
    () => ({
      jumpToNextHunk: () => jumpToNextHunkRef.current?.() ?? false,
    }),
    [],
  );

  useLayoutEffect(() => {
    if (!fileKey || !bodyRef.current || typeof retainedScrollTop !== "number") {
      return;
    }
    bodyRef.current.scrollTop = retainedScrollTop;
  }, [fileKey, retainedScrollTop]);

  useLayoutEffect(() => {
    return () => {
      if (!fileKey || !bodyRef.current) {
        return;
      }
      onRetainScrollTop?.(fileKey, bodyRef.current.scrollTop);
    };
  }, [fileKey, onRetainScrollTop]);

  return (
    <section className="git-diff-preview-pane">
      <div className="git-diff-preview-body" ref={bodyRef}>
        {file && fileKey ? (
          <GitDiffBody
            file={file}
            fileKey={fileKey}
            projectId={projectId}
            source={source}
            retainedDiffView={retainedDiffView}
            onRetainDiffView={onRetainDiffView}
            paneHeader={{
              title: fileName ?? file.path,
              path: file.path,
              actions: headerActions,
            }}
            onJumpHandlerChange={handleJumpHandlerChange}
            t={t}
          />
        ) : (
          <>
            <DiffPaneToolbar
              title={t("gitStatusDiffPreview")}
              path=""
              actions={headerActions}
            />
            <div className="git-diff-placeholder">
              {t("gitStatusSelectFileForDiff")}
            </div>
          </>
        )}
      </div>
    </section>
  );
});

export function GitDiffModal({
  file,
  fileKey,
  projectId,
  source = WORKTREE_SOURCE,
  headerActions,
  retainedDiffView,
  onRetainDiffView,
  t,
  onClose,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
  /** Actions for the selected file, shown above the diff (the file banner). */
  headerActions?: ReactNode;
  retainedDiffView?: GitDiffViewState;
  onRetainDiffView?: (fileKey: string, view: GitDiffViewState) => void;
  t: TranslationFn;
  onClose: () => void;
}) {
  return (
    <Modal title={file.path} onClose={onClose} closeOnBackGesture>
      {headerActions && (
        <div className="git-diff-preview-header-actions">{headerActions}</div>
      )}
      <GitDiffBody
        file={file}
        fileKey={fileKey}
        projectId={projectId}
        source={source}
        retainedDiffView={retainedDiffView}
        onRetainDiffView={onRetainDiffView}
        t={t}
      />
    </Modal>
  );
}

export function GitDiffBody({
  file,
  fileKey,
  projectId,
  source = WORKTREE_SOURCE,
  retainedDiffView,
  onRetainDiffView,
  paneHeader,
  onJumpHandlerChange,
  t,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
  paneHeader?: DiffPaneHeader;
  onJumpHandlerChange?: (handler: (() => boolean) | null) => void;
  t: TranslationFn;
} & GitDiffPreviewRetentionProps) {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Depend on the source's primitives (a fresh `{kind,sha}` object each render
  // would refetch on every render); reconstruct it inside the effect.
  const sourceKind = source.kind;
  const sourceSha = source.kind === "commit" ? source.sha : "";

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setDiffResult(null);
    setError(null);

    fetchDiffForSource(projectId, file, sourceFromPrimitives(sourceKind, sourceSha))
      .then((result) => {
        if (!cancelled) {
          setDiffResult(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || t("gitStatusLoadDiffFailed"));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, file, sourceKind, sourceSha, t]);

  return (
    <>
      {paneHeader && (loading || error) && (
        <DiffPaneToolbar
          title={paneHeader.title}
          path={paneHeader.path}
          actions={paneHeader.actions}
        />
      )}
      {loading && (
        <div className="git-diff-loading">{t("gitStatusLoadingDiff")}</div>
      )}
      {!loading && error && <div className="git-diff-error">{error}</div>}
      {!loading && !error && diffResult && (
        <GitDiffContent
          key={fileKey}
          file={file}
          fileKey={fileKey}
          projectId={projectId}
          source={source}
          diffResult={diffResult}
          retainedDiffView={retainedDiffView}
          onRetainDiffView={onRetainDiffView}
          paneHeader={paneHeader}
          onJumpHandlerChange={onJumpHandlerChange}
          t={t}
        />
      )}
    </>
  );
}

function GitDiffContent({
  file,
  fileKey,
  projectId,
  source = WORKTREE_SOURCE,
  diffResult,
  retainedDiffView,
  onRetainDiffView,
  paneHeader,
  onJumpHandlerChange,
  t,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
  diffResult: GitDiffResult;
  paneHeader?: DiffPaneHeader;
  onJumpHandlerChange?: (handler: (() => boolean) | null) => void;
  t: TranslationFn;
} & GitDiffPreviewRetentionProps) {
  const [showFullContext, setShowFullContext] = useState(
    () => retainedDiffView?.showFullContext ?? false,
  );
  const [fullContextResult, setFullContextResult] =
    useState<GitDiffResult | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(
    () => retainedDiffView?.showMarkdownPreview ?? false,
  );
  const contentRef = useRef<HTMLDivElement>(null);
  const [viewMode, setViewMode] = useDiffViewMode();
  const [paneWidth, setPaneWidth] = useState(0);
  const sourceKind = source.kind;
  const sourceSha = source.kind === "commit" ? source.sha : "";

  // Measure the diff pane (content width, not viewport) so `auto` can pick
  // side-by-side only when two readable code columns fit.
  useEffect(() => {
    const el = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === "number") setPaneWidth(width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const cycleViewMode = useCallback(() => {
    setViewMode(
      viewMode === "auto"
        ? "unified"
        : viewMode === "unified"
          ? "side-by-side"
          : "auto",
    );
  }, [viewMode, setViewMode]);

  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const hasMarkdownPreview =
    isMarkdown &&
    !!(fullContextResult?.markdownHtml || diffResult.markdownHtml);

  const retainDiffView = useCallback(
    (view: GitDiffViewState) => {
      onRetainDiffView?.(fileKey, view);
    },
    [fileKey, onRetainDiffView],
  );

  const loadFullContext = useCallback(async () => {
    if (fullContextResult || contextLoading) {
      return true;
    }
    setContextLoading(true);
    setContextError(null);
    try {
      const result = await fetchDiffForSource(
        projectId,
        file,
        sourceFromPrimitives(sourceKind, sourceSha),
        true,
      );
      setFullContextResult(result);
      return true;
    } catch (err) {
      setContextError(
        err instanceof Error ? err.message : t("gitStatusLoadContextFailed"),
      );
      return false;
    } finally {
      setContextLoading(false);
    }
  }, [
    fullContextResult,
    contextLoading,
    projectId,
    file,
    sourceKind,
    sourceSha,
    t,
  ]);

  const handleToggleContext = useCallback(async () => {
    const nextShowFullContext = !showFullContext;
    if (nextShowFullContext && !(await loadFullContext())) {
      return;
    }
    setShowFullContext(nextShowFullContext);
    retainDiffView({ showFullContext: nextShowFullContext });
  }, [loadFullContext, retainDiffView, showFullContext]);

  const handleToggleMarkdownPreview = useCallback(() => {
    const nextShowMarkdownPreview = !showMarkdownPreview;
    setShowMarkdownPreview(nextShowMarkdownPreview);
    retainDiffView({ showMarkdownPreview: nextShowMarkdownPreview });
  }, [retainDiffView, showMarkdownPreview]);

  useEffect(() => {
    if (showFullContext && !fullContextResult && !contextLoading) {
      void loadFullContext();
    }
  }, [contextLoading, fullContextResult, loadFullContext, showFullContext]);

  useEffect(() => {
    if (!hasMarkdownPreview && showMarkdownPreview) {
      setShowMarkdownPreview(false);
      retainDiffView({ showMarkdownPreview: false });
    }
  }, [hasMarkdownPreview, retainDiffView, showMarkdownPreview]);

  // Scroll to first changed line when showing full context
  useEffect(() => {
    if (showFullContext && fullContextResult && contentRef.current) {
      requestAnimationFrame(() => {
        const firstChange = contentRef.current?.querySelector(
          ".line-deleted, .line-inserted",
        );
        if (firstChange) {
          firstChange.scrollIntoView({ block: "center", behavior: "instant" });
        }
      });
    }
  }, [showFullContext, fullContextResult]);

  const displayResult =
    showFullContext && fullContextResult ? fullContextResult : diffResult;

  const markdownHtml =
    fullContextResult?.markdownHtml || diffResult.markdownHtml;
  const oversizedHtmlSkip = getOversizedDiffHtmlSkip(displayResult.diffHtml);
  const previewSkipped = displayResult.previewSkipped ?? oversizedHtmlSkip;
  const [hunkPosition, setHunkPosition] = useState({ index: 0, count: 0 });
  const hunkPositionRef = useRef(hunkPosition);

  useEffect(() => {
    hunkPositionRef.current = hunkPosition;
  }, [hunkPosition]);

  const renderedHunks = useCallback((): HTMLElement[] => {
    if (showMarkdownPreview || previewSkipped || !contentRef.current) return [];
    return Array.from(
      contentRef.current.querySelectorAll<HTMLElement>(".line-hunk"),
    );
  }, [previewSkipped, showMarkdownPreview]);

  const updateHunkPosition = useCallback(() => {
    const content = contentRef.current;
    const hunks = renderedHunks();
    if (!content || hunks.length === 0) {
      setHunkPosition((current) =>
        current.count === 0 ? current : { index: 0, count: 0 },
      );
      return;
    }
    const scrollRoot =
      content.closest<HTMLElement>(".git-diff-preview-body") ?? content;
    const threshold = scrollRoot.getBoundingClientRect().top + 52;
    let index = 0;
    for (let i = 0; i < hunks.length; i++) {
      const hunk = hunks[i];
      if (hunk && hunk.getBoundingClientRect().top <= threshold) index = i;
      else break;
    }
    setHunkPosition((current) =>
      current.index === index && current.count === hunks.length
        ? current
        : { index, count: hunks.length },
    );
  }, [renderedHunks]);

  const jumpToNextHunk = useCallback((): boolean => {
    const hunks = renderedHunks();
    if (hunks.length === 0) return false;
    const current =
      hunkPositionRef.current.count === hunks.length
        ? hunkPositionRef.current.index
        : 0;
    const next = (current + 1) % hunks.length;
    const nextHunk = hunks[next];
    if (!nextHunk || typeof nextHunk.scrollIntoView !== "function") {
      return false;
    }
    nextHunk.scrollIntoView({ block: "start", behavior: "smooth" });
    setHunkPosition({ index: next, count: hunks.length });
    return true;
  }, [renderedHunks]);

  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const scrollRoot =
      content.closest<HTMLElement>(".git-diff-preview-body") ?? content;
    // Coalesce to one measurement per frame: the update queries every rendered
    // hunk's rect, which is too much work to repeat per scroll event.
    let frame = requestAnimationFrame(updateHunkPosition);
    let scheduled = false;
    const onScroll = () => {
      if (scheduled) return;
      scheduled = true;
      frame = requestAnimationFrame(() => {
        scheduled = false;
        updateHunkPosition();
      });
    };
    scrollRoot.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      scrollRoot.removeEventListener("scroll", onScroll);
    };
  }, [updateHunkPosition]);

  useEffect(() => {
    onJumpHandlerChange?.(jumpToNextHunk);
    return () => onJumpHandlerChange?.(null);
  }, [jumpToNextHunk, onJumpHandlerChange]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "n" ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        isTypingTarget(event.target)
      ) {
        return;
      }
      if (jumpToNextHunk()) event.preventDefault();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [jumpToNextHunk]);

  const hunkButton =
    hunkPosition.count > 0 ? (
      <button
        type="button"
        className="diff-hunk-indicator"
        onClick={jumpToNextHunk}
        title={t("sourceNextHunkShortcut")}
      >
        {t("sourceHunkPosition", {
          current: hunkPosition.index + 1,
          total: hunkPosition.count,
        })}
      </button>
    ) : null;

  const toolbarButtons = (
    <>
      {hunkButton}
      {hasMarkdownPreview && (
        <button
          type="button"
          className={`diff-context-toggle ${showMarkdownPreview ? "active" : ""}`}
          onClick={handleToggleMarkdownPreview}
        >
          {showMarkdownPreview ? t("gitStatusDiff") : t("gitStatusPreview")}
        </button>
      )}
      {!showMarkdownPreview && (
        <button
          type="button"
          className="diff-context-toggle"
          onClick={handleToggleContext}
          disabled={contextLoading}
        >
          {contextLoading
            ? t("gitStatusLoading")
            : showFullContext
              ? t("gitStatusDiffOnly")
              : t("gitStatusFullContext")}
        </button>
      )}
      {!showMarkdownPreview && (
        <button
          type="button"
          className="diff-context-toggle"
          onClick={cycleViewMode}
          title={t("diffViewModeTitle")}
        >
          {t(diffViewModeLabelKey(viewMode))}
        </button>
      )}
    </>
  );

  return (
    <>
      {paneHeader ? (
        <DiffPaneToolbar
          title={paneHeader.title}
          path={paneHeader.path}
          actions={paneHeader.actions}
        >
          {toolbarButtons}
        </DiffPaneToolbar>
      ) : (
        <div className="diff-context-controls source-diff-context-controls">
          <span className="diff-context-path">{file.path}</span>
          <div className="diff-context-buttons">{toolbarButtons}</div>
        </div>
      )}
      {contextError && <div className="diff-context-error">{contextError}</div>}
      <div className="diff-modal-content source-diff-pane" ref={contentRef}>
        {showMarkdownPreview && markdownHtml ? (
          <MarkdownPreview html={markdownHtml} />
        ) : previewSkipped ? (
          <GitDiffPreviewSkippedState
            file={file}
            previewSkipped={previewSkipped}
            t={t}
          />
        ) : (
          <>
            {displayResult.diffHtml &&
            resolveDiffViewMode(viewMode, paneWidth) === "side-by-side" ? (
              <SideBySideDiff
                diffHtml={displayResult.diffHtml}
                structuredPatch={displayResult.structuredPatch}
              />
            ) : displayResult.diffHtml ? (
              <HighlightedDiff diffHtml={displayResult.diffHtml} />
            ) : (
              <DiffLines hunks={displayResult.structuredPatch} />
            )}
            <DiffCommentLayer
              projectId={projectId}
              filePath={file.path}
              structuredPatch={displayResult.structuredPatch}
              revision={commentRevisionForSource(source)}
              containerRef={contentRef}
              t={t}
            />
          </>
        )}
      </div>
    </>
  );
}

function DiffPaneToolbar({
  title,
  path,
  actions,
  children,
}: DiffPaneHeader & { children?: ReactNode }) {
  return (
    <div className="git-diff-pane-toolbar">
      <h3 className="git-diff-preview-title" title={path || title}>
        {title}
      </h3>
      {path && path !== title && (
        <span className="git-diff-toolbar-path" title={path}>
          {path}
        </span>
      )}
      {children && <div className="diff-context-buttons">{children}</div>}
      {actions && (
        <div className="git-diff-preview-header-actions">{actions}</div>
      )}
    </div>
  );
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  );
}

function diffViewModeLabelKey(mode: DiffViewMode): string {
  switch (mode) {
    case "unified":
      return "diffViewModeUnified";
    case "side-by-side":
      return "diffViewModeSideBySide";
    default:
      return "diffViewModeAuto";
  }
}

function GitDiffPreviewSkippedState({
  file,
  previewSkipped,
  t,
}: {
  file: GitFileChange;
  previewSkipped: GitDiffPreviewSkipped;
  t: TranslationFn;
}) {
  return (
    <div className="git-diff-preview-skipped">
      <div className="git-diff-preview-skipped-title">
        {t("gitStatusDiffPreviewSkipped")}
      </div>
      <div className="git-diff-preview-skipped-message">
        {getDiffPreviewSkippedMessage(previewSkipped, t)}
      </div>
      <dl className="git-diff-preview-skipped-details">
        <div>
          <dt>{t("gitStatusDiffPreviewSkippedPath")}</dt>
          <dd>{file.path}</dd>
        </div>
        {previewSkipped.totalBytes !== undefined && (
          <div>
            <dt>{t("gitStatusDiffPreviewSkippedSize")}</dt>
            <dd>{formatBytes(previewSkipped.totalBytes)}</dd>
          </div>
        )}
        {previewSkipped.maxLineChars !== undefined && (
          <div>
            <dt>{t("gitStatusDiffPreviewSkippedLineLength")}</dt>
            <dd>{previewSkipped.maxLineChars.toLocaleString()}</dd>
          </div>
        )}
        {previewSkipped.htmlChars !== undefined && (
          <div>
            <dt>{t("gitStatusDiffPreviewSkippedHtmlSize")}</dt>
            <dd>{previewSkipped.htmlChars.toLocaleString()}</dd>
          </div>
        )}
      </dl>
    </div>
  );
}

function getOversizedDiffHtmlSkip(
  diffHtml: string,
): GitDiffPreviewSkipped | null {
  if (diffHtml.length <= GIT_DIFF_MAX_RENDERED_HTML_CHARS) {
    return null;
  }

  return {
    reason: "html-too-large",
    htmlChars: diffHtml.length,
    maxHtmlChars: GIT_DIFF_MAX_RENDERED_HTML_CHARS,
  };
}

function getDiffPreviewSkippedMessage(
  previewSkipped: GitDiffPreviewSkipped,
  t: TranslationFn,
): string {
  switch (previewSkipped.reason) {
    case "content-too-large":
      return t("gitStatusDiffPreviewSkippedContentTooLarge");
    case "line-too-long":
      return t("gitStatusDiffPreviewSkippedLineTooLong");
    case "html-too-large":
      return t("gitStatusDiffPreviewSkippedHtmlTooLarge");
  }
  return t("gitStatusDiffPreviewSkippedContentTooLarge");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${formatFraction(bytes / 1024)} KB`;
  }
  return `${formatFraction(bytes / (1024 * 1024))} MB`;
}

function formatFraction(value: number): string {
  return value >= 10 ? value.toFixed(0) : value.toFixed(1);
}

/** Render syntax-highlighted diff HTML from server */
const HighlightedDiff = memo(function HighlightedDiff({
  diffHtml,
}: {
  diffHtml: string;
}) {
  return (
    <div
      className="highlighted-diff"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki output is safe
      dangerouslySetInnerHTML={{ __html: diffHtml }}
    />
  );
});

/** Fallback plain-text diff renderer */
const DiffLines = memo(function DiffLines({ hunks }: { hunks: PatchHunk[] }) {
  const rows: ReactNode[] = [];
  let flatIndex = 0;
  for (const [hunkIndex, hunk] of hunks.entries()) {
    rows.push(
      <div
        key={`hunk-${hunkIndex}`}
        className="line line-hunk"
      >{`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}</div>,
    );
    for (const line of hunk.lines) {
      const prefix = line[0];
      const className =
        prefix === "-"
          ? "diff-removed"
          : prefix === "+"
            ? "diff-added"
            : "diff-context";
      const rowIndex = flatIndex++;
      rows.push(
        <div
          key={`${rowIndex}-${line.slice(0, 50)}`}
          className={className}
          data-diff-line={rowIndex}
        >
          {line}
        </div>,
      );
    }
  }
  return (
    <div className="diff-hunk">
      <pre className="diff-content">{rows}</pre>
    </div>
  );
});
