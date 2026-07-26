import type {
  GitDiffPreviewSkipped,
  GitDiffResult,
  GitFileChange,
  ReviewCommentRevision,
} from "@yep-anywhere/shared";
import {
  memo,
  useCallback,
  useEffect,
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

/**
 * Which revision a diff pane shows: the working tree (an `uncommitted`
 * comment anchor) or a specific commit (a `sha` anchor). The commit browser
 * reuses this whole diff+comment stack by passing `{ kind: "commit", sha }`,
 * so a comment left on a commit diff flows through the exact same
 * relocation/compose pipeline as a working-tree comment.
 */
export type GitDiffSource =
  | { kind: "worktree" }
  | { kind: "commit"; sha: string };

const WORKTREE_SOURCE: GitDiffSource = { kind: "worktree" };

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

export function GitDiffPreview({
  file,
  fileKey,
  projectId,
  source = WORKTREE_SOURCE,
  retainedScrollTop,
  retainedDiffView,
  onRetainScrollTop,
  onRetainDiffView,
  t,
}: {
  file: GitFileChange | null;
  fileKey: string | null;
  projectId: string;
  source?: GitDiffSource;
  retainedScrollTop?: number;
  retainedDiffView?: GitDiffViewState;
  onRetainScrollTop?: (fileKey: string, scrollTop: number) => void;
  onRetainDiffView?: (fileKey: string, view: GitDiffViewState) => void;
  t: TranslationFn;
}) {
  const fileName = file ? file.path.split("/").pop() || file.path : null;
  const bodyRef = useRef<HTMLDivElement | null>(null);

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
      <div className="git-diff-preview-header">
        <h3 className="git-diff-preview-title">
          {fileName ?? t("gitStatusDiffPreview")}
        </h3>
      </div>
      <div className="git-diff-preview-body" ref={bodyRef}>
        {file && fileKey ? (
          <GitDiffBody
            file={file}
            fileKey={fileKey}
            projectId={projectId}
            source={source}
            retainedDiffView={retainedDiffView}
            onRetainDiffView={onRetainDiffView}
            t={t}
          />
        ) : (
          <div className="git-diff-placeholder">
            {t("gitStatusSelectFileForDiff")}
          </div>
        )}
      </div>
    </section>
  );
}

export function GitDiffModal({
  file,
  fileKey,
  projectId,
  source = WORKTREE_SOURCE,
  retainedDiffView,
  onRetainDiffView,
  t,
  onClose,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
  retainedDiffView?: GitDiffViewState;
  onRetainDiffView?: (fileKey: string, view: GitDiffViewState) => void;
  t: TranslationFn;
  onClose: () => void;
}) {
  const fileName = file.path.split("/").pop() || file.path;

  return (
    <Modal title={fileName} onClose={onClose}>
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
  t,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
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

    const effectiveSource: GitDiffSource =
      sourceKind === "commit"
        ? { kind: "commit", sha: sourceSha }
        : WORKTREE_SOURCE;
    fetchDiffForSource(projectId, file, effectiveSource)
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
  t,
}: {
  file: GitFileChange;
  fileKey: string;
  projectId: string;
  source?: GitDiffSource;
  diffResult: GitDiffResult;
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
      const effectiveSource: GitDiffSource =
        sourceKind === "commit"
          ? { kind: "commit", sha: sourceSha }
          : WORKTREE_SOURCE;
      const result = await fetchDiffForSource(
        projectId,
        file,
        effectiveSource,
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

  return (
    <div className="diff-modal-content" ref={contentRef}>
      <div className="diff-context-controls">
        <span className="diff-context-path">{file.path}</span>
        <div className="diff-context-buttons">
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
        </div>
        {contextError && (
          <span className="diff-context-error">{contextError}</span>
        )}
      </div>

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
            <DiffLines
              lines={displayResult.structuredPatch.flatMap((h) => h.lines)}
            />
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
const DiffLines = memo(function DiffLines({ lines }: { lines: string[] }) {
  return (
    <div className="diff-hunk">
      <pre className="diff-content">
        {lines.map((line, i) => {
          const prefix = line[0];
          const className =
            prefix === "-"
              ? "diff-removed"
              : prefix === "+"
                ? "diff-added"
                : "diff-context";
          return (
            <div
              key={`${i}-${line.slice(0, 50)}`}
              className={className}
              data-diff-line={i}
            >
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});
