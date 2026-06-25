import type { GitFileChange } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../api/client";
import type { useI18n } from "../../i18n";
import { DiffLines } from "../renderers/DiffLines";
import { formatGitStatusBadge } from "./utils";

interface PatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

interface GitDiffResult {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  markdownHtml?: string;
}

type Translate = ReturnType<typeof useI18n>["t"];

export function GitPreviewPane({
  file,
  projectId,
  historyCommit,
  stashRef,
  t,
}: {
  file: GitFileChange;
  projectId: string;
  historyCommit?: {
    hash: string;
    previousPath?: string;
  };
  stashRef?: {
    ref: string;
    previousPath?: string;
  };
  t: Translate;
}) {
  const historyCommitHash = historyCommit?.hash;
  const historyPreviousPath = historyCommit?.previousPath;
  const currentStashRef = stashRef?.ref;
  const stashPreviousPath = stashRef?.previousPath;
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [fullContextResult, setFullContextResult] =
    useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [showFullContext, setShowFullContext] = useState(false);
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    setError(null);
    setContextError(null);
    setShowFullContext(false);
    setShowMarkdownPreview(false);
    setFullContextResult(null);

    const fetchDiff = historyCommitHash
      ? api.getGitHistoryDiff(projectId, {
          commit: historyCommitHash,
          path: file.path,
          status: file.status,
          previousPath: historyPreviousPath,
        })
      : currentStashRef
        ? api.getGitStashDiff(projectId, {
            stashRef: currentStashRef,
            path: file.path,
            status: file.status,
            previousPath: stashPreviousPath,
          })
        : api.getGitDiff(projectId, {
            path: file.path,
            staged: file.staged,
            status: file.status,
          });

    fetchDiff
      .then((result) => {
        if (cancelled) return;
        setDiffResult(result);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || t("gitStatusLoadDiffFailed"));
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [
    file.path,
    file.staged,
    file.status,
    historyCommitHash,
    historyPreviousPath,
    projectId,
    currentStashRef,
    stashPreviousPath,
    t,
  ]);

  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const markdownHtml =
    fullContextResult?.markdownHtml || diffResult?.markdownHtml;
  const hasMarkdownPreview = isMarkdown && Boolean(markdownHtml);
  const displayResult =
    showFullContext && fullContextResult ? fullContextResult : diffResult;

  const handleToggleContext = useCallback(async () => {
    if (!showFullContext && !fullContextResult) {
      setContextLoading(true);
      setContextError(null);
      try {
        const result = historyCommitHash
          ? await api.getGitHistoryDiff(projectId, {
              commit: historyCommitHash,
              path: file.path,
              status: file.status,
              previousPath: historyPreviousPath,
              fullContext: true,
            })
          : currentStashRef
            ? await api.getGitStashDiff(projectId, {
                stashRef: currentStashRef,
                path: file.path,
                status: file.status,
                previousPath: stashPreviousPath,
                fullContext: true,
              })
            : await api.getGitDiff(projectId, {
                path: file.path,
                staged: file.staged,
                status: file.status,
                fullContext: true,
              });
        setFullContextResult(result);
      } catch (err) {
        setContextError(
          err instanceof Error ? err.message : t("gitStatusLoadContextFailed"),
        );
        setContextLoading(false);
        return;
      }
      setContextLoading(false);
    }

    setShowFullContext((value) => !value);
  }, [
    file.path,
    file.staged,
    file.status,
    fullContextResult,
    historyCommitHash,
    historyPreviousPath,
    projectId,
    showFullContext,
    currentStashRef,
    stashPreviousPath,
    t,
  ]);

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
  }, [fullContextResult, showFullContext]);

  if (loading) {
    return <div className="git-diff-loading">{t("gitStatusLoadingDiff")}</div>;
  }

  if (error) {
    return <div className="git-diff-error">{error}</div>;
  }

  if (!displayResult) {
    return <div className="git-preview-empty">{t("gitStatusNoPreview")}</div>;
  }

  return (
    <div className="git-preview-pane" ref={contentRef}>
      <div className="diff-context-controls git-preview-toolbar">
        <div className="git-preview-title">
          <span
            className={`git-status-badge git-status-${file.status.toLowerCase()}`}
          >
            {formatGitStatusBadge(file.status)}
          </span>
          <span className="diff-context-path">{file.path}</span>
        </div>
        <div className="diff-context-buttons">
          {hasMarkdownPreview ? (
            <button
              type="button"
              className={`diff-context-toggle ${showMarkdownPreview ? "active" : ""}`}
              onClick={() => setShowMarkdownPreview((value) => !value)}
            >
              {showMarkdownPreview ? t("gitStatusDiff") : t("gitStatusPreview")}
            </button>
          ) : null}
          {!showMarkdownPreview ? (
            <button
              type="button"
              className={`diff-context-toggle ${showFullContext ? "active" : ""}`}
              onClick={() => void handleToggleContext()}
              disabled={contextLoading}
            >
              {contextLoading
                ? t("gitStatusLoading")
                : showFullContext
                  ? t("gitStatusDiffOnly")
                  : t("gitStatusFullContext")}
            </button>
          ) : null}
        </div>
      </div>

      <div className="git-preview-body">
        {contextError ? (
          <div className="git-diff-error">{contextError}</div>
        ) : null}

        {showMarkdownPreview && markdownHtml ? (
          <div className="markdown-preview git-preview-scroll">
            <div
              className="markdown-rendered"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered HTML
              dangerouslySetInnerHTML={{ __html: markdownHtml }}
            />
          </div>
        ) : displayResult.diffHtml ? (
          <HighlightedDiff diffHtml={displayResult.diffHtml} />
        ) : (
          <DiffLines
            lines={displayResult.structuredPatch.flatMap((hunk) => hunk.lines)}
          />
        )}
      </div>
    </div>
  );
}

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

