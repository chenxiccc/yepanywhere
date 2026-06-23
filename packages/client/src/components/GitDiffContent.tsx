import type { GitFileChange } from "@yep-anywhere/shared";
import { memo, useCallback } from "react";
import { useI18n } from "../i18n";
import type { GitDiffResult } from "../hooks/useGitDiff";

interface GitDiffContentProps {
  file: GitFileChange;
  projectId: string;
  diffResult: GitDiffResult | null;
  loading: boolean;
  error: string | null;
  fullContextResult: GitDiffResult | null;
  contextLoading: boolean;
  contextError: string | null;
  showFullContext: boolean;
  toggleFullContext: () => void;
  showMarkdownPreview: boolean;
  setShowMarkdownPreview: (v: boolean) => void;
  hasMarkdownPreview: boolean;
  markdownHtml: string | undefined;
  displayResult: GitDiffResult | null;
  contentRef: React.RefObject<HTMLDivElement | null>;
}

/**
 * 纯渲染 Diff 组件，不包含任何状态管理
 * Pure rendering diff component — no state management.
 *
 * 被 GitDiffModal 和 GitDiffPanel 共享使用
 * Used by both GitDiffModal and GitDiffPanel.
 */
export function GitDiffContent({
  file,
  projectId: _projectId,
  diffResult: _initialDiffResult,
  loading,
  error,
  fullContextResult: _fullContextResult,
  contextLoading,
  contextError,
  showFullContext,
  toggleFullContext,
  showMarkdownPreview,
  setShowMarkdownPreview,
  hasMarkdownPreview,
  markdownHtml,
  displayResult,
  contentRef,
}: GitDiffContentProps) {
  const { t } = useI18n();

  const handleToggleContext = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      toggleFullContext();
    },
    [toggleFullContext],
  );

  return (
    <div className="diff-modal-content" ref={contentRef}>
      {loading ? (
        <div className="git-diff-loading">
          {t("gitStatusLoadingDiff" as never)}
        </div>
      ) : error ? (
        <div className="git-diff-error">{error}</div>
      ) : displayResult ? (
        <>
          <div className="diff-context-controls">
            <span className="diff-context-path">{file.path}</span>
            <div className="diff-context-buttons">
              {hasMarkdownPreview && (
                <button
                  type="button"
                  className={`diff-context-toggle ${showMarkdownPreview ? "active" : ""}`}
                  onClick={() => setShowMarkdownPreview(!showMarkdownPreview)}
                >
                  {showMarkdownPreview
                    ? t("gitStatusDiff" as never)
                    : t("gitStatusPreview" as never)}
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
                    ? t("gitStatusLoading" as never)
                    : showFullContext
                      ? t("gitStatusDiffOnly" as never)
                      : t("gitStatusFullContext" as never)}
                </button>
              )}
            </div>
            {contextError && (
              <span className="diff-context-error">{contextError}</span>
            )}
          </div>

          {showMarkdownPreview && markdownHtml ? (
            <div className="markdown-preview">
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
              lines={displayResult.structuredPatch.flatMap((h) => h.lines)}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

/** 渲染语法高亮的 diff HTML / Render syntax-highlighted diff HTML */
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

/** 降级纯文本 diff 渲染 / Fallback plain-text diff renderer */
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
            <div key={`${i}-${line.slice(0, 50)}`} className={className}>
              {line}
            </div>
          );
        })}
      </pre>
    </div>
  );
});