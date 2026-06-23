import type { GitFileChange, PatchHunk } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

interface GitDiffResult {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  markdownHtml?: string;
}

interface UseGitDiffOptions {
  projectId: string;
  file: GitFileChange;
  /** 可选：历史提交的 hash，用于获取 commit-based diff / Optional commit hash for commit-based diff */
  commitHash?: string;
  /**
   * 是否启用 diff 加载，默认 true。
   * 设为 false 时跳过 API 请求（例如未选中文件时）。
   * Whether to enable diff loading, default true.
   * Set to false to skip API requests (e.g. when no file is selected).
   */
  enabled?: boolean;
}

/**
 * 共享 Diff 状态 Hook，封装所有 diff 加载逻辑、全上下文切换、markdown 预览
 * Shared Diff state hook — encapsulates all diff loading, full-context toggle,
 * and markdown preview logic.
 *
 * 被 GitDiffModal、GitDiffPanel 和 GitCommitDetail 共享使用
 * Used by GitDiffModal, GitDiffPanel, and GitCommitDetail.
 */
export function useGitDiff({ projectId, file, commitHash, enabled = true }: UseGitDiffOptions) {
  const [diffResult, setDiffResult] = useState<GitDiffResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 全上下文 / Full context
  const [fullContextResult, setFullContextResult] =
    useState<GitDiffResult | null>(null);
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState<string | null>(null);
  const [showFullContext, setShowFullContext] = useState(false);

  // Markdown 预览 / Markdown preview
  const [showMarkdownPreview, setShowMarkdownPreview] = useState(false);

  const contentRef = useRef<HTMLDivElement>(null);

  // 加载 diff / Load diff
  useEffect(() => {
    if (!enabled || !file.path) {
      setLoading(false);
      setDiffResult(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const diffPromise = commitHash
      ? api.getGitCommitDiff(projectId, commitHash, {
          path: file.path,
        })
      : api.getGitDiff(projectId, {
          path: file.path,
          staged: file.staged,
          status: file.status,
        });

    diffPromise
      .then((result) => {
        if (!cancelled) {
          setDiffResult(result);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err.message || "Failed to load diff");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId, file.path, file.staged, file.status, commitHash]);

  // 切换全上下文 / Toggle full context
  const toggleFullContext = useCallback(async () => {
    if (!showFullContext && !fullContextResult) {
      setContextLoading(true);
      setContextError(null);
      try {
        const result = commitHash
          ? await api.getGitCommitDiff(projectId, commitHash, {
              path: file.path,
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
          err instanceof Error ? err.message : "Failed to load full context",
        );
        setContextLoading(false);
        return;
      }
      setContextLoading(false);
    }
    setShowFullContext((prev) => !prev);
  }, [
    showFullContext,
    fullContextResult,
    projectId,
    commitHash,
    file.path,
    file.staged,
    file.status,
  ]);

  // 滚动到第一个变更行 / Scroll to first changed line
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

  // 计算属性 / Computed values
  const isMarkdown = /\.(md|markdown)$/i.test(file.path);
  const hasMarkdownPreview =
    isMarkdown &&
    !!(fullContextResult?.markdownHtml || diffResult?.markdownHtml);

  const displayResult =
    showFullContext && fullContextResult ? fullContextResult : diffResult;

  const markdownHtml =
    fullContextResult?.markdownHtml || diffResult?.markdownHtml;

  return {
    diffResult,
    loading,
    error,
    fullContextResult,
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
  };
}

export type { GitDiffResult, PatchHunk };