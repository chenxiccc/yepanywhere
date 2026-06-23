import type { GitCommit } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useI18n } from "../i18n";
import { CopyTextButton } from "./ui/CopyTextButton";

interface GitHistoryPanelProps {
  projectId: string;
  /** 点击提交回调 / Commit click callback */
  onCommitClick?: (hash: string) => void;
  /** 当前选中的提交 hash / Currently selected commit hash */
  selectedHash?: string | null;
}

/**
 * Git 提交历史面板，支持无限滚动加载更多
 * Git commit history panel with infinite scroll.
 */
export function GitHistoryPanel({
  projectId,
  onCommitClick,
  selectedHash,
}: GitHistoryPanelProps) {
  const { t } = useI18n();
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement>(null);

  const PAGE_SIZE = 50;

  // 初始加载 / Initial load
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .getGitLog(projectId, { limit: PAGE_SIZE })
      .then((data) => {
        if (!cancelled) {
          setCommits(data.commits);
          setHasMore(data.commits.length >= PAGE_SIZE);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load history");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // 无限滚动 / Infinite scroll
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;
    setLoadingMore(true);
    try {
      const data = await api.getGitLog(projectId, {
        limit: PAGE_SIZE,
        skip: commits.length,
      });
      setCommits((prev) => [...prev, ...data.commits]);
      setHasMore(data.commits.length >= PAGE_SIZE);
    } catch (_err) {
      // 静默失败，不覆盖已有数据 / Silent fail, keep existing data
    } finally {
      setLoadingMore(false);
    }
  }, [projectId, commits.length, loadingMore, hasMore]);

  // IntersectionObserver 监听滚动到底部 / Observe scroll to bottom
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0.1 },
    );

    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [loadMore]);

  const handleClick = useCallback(
    (hash: string) => {
      onCommitClick?.(hash);
    },
    [onCommitClick],
  );

  return (
    <div className="git-history-list">
      {loading ? (
        <div className="git-history-loading">Loading…</div>
      ) : error ? (
        <div className="git-history-error">{error}</div>
      ) : commits.length === 0 ? (
        <div className="git-history-empty">暂无提交记录</div>
      ) : (
        <>
          {commits.map((commit) => (
            <div
              key={commit.hash}
              className={`git-history-item git-history-item-clickable${selectedHash === commit.hash ? " selected" : ""}`}
              onClick={() => handleClick(commit.hash)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleClick(commit.hash);
                }
              }}
              role="button"
              tabIndex={0}
            >
              <span className="git-history-message">
                {commit.message}
              </span>
              <span className="git-history-meta">
                <span className="git-history-hash">
                  {commit.hash.slice(0, 7)}
                </span>
                <CopyTextButton
                  text={commit.hash}
                  label={t("sourceFileCopyCommitHash" as never)}
                  className="git-history-copy-btn"
                  copiedClassName="copied"
                  copiedLabel={t("sourceFileCopyCommitHash" as never)}
                />
                <span className="git-history-author">{commit.author}</span>
                <span className="git-history-date">
                  {formatRelativeTime(commit.date)}
                </span>
              </span>
            </div>
          ))}
          {loadingMore && (
            <div className="git-history-loading">Loading more…</div>
          )}
          {!hasMore && commits.length > 0 && (
            <div className="git-history-end">— End —</div>
          )}
          <div ref={sentinelRef} style={{ height: 1 }} />
        </>
      )}
    </div>
  );
}

/** 格式化相对时间 / Format relative time using Intl.RelativeTimeFormat */
function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = Date.now();
  const diffMs = date.getTime() - now;
  const diffSec = Math.round(diffMs / 1000);
  const diffMin = Math.round(diffSec / 60);
  const diffHour = Math.round(diffMin / 60);
  const diffDay = Math.round(diffHour / 24);
  const diffMonth = Math.round(diffDay / 30);
  const diffYear = Math.round(diffDay / 365);

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  if (Math.abs(diffSec) < 60) return rtf.format(diffSec, "second");
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, "minute");
  if (Math.abs(diffHour) < 24) return rtf.format(diffHour, "hour");
  if (Math.abs(diffDay) < 30) return rtf.format(diffDay, "day");
  if (Math.abs(diffMonth) < 12) return rtf.format(diffMonth, "month");
  return rtf.format(diffYear, "year");
}