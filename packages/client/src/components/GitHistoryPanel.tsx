import type { GitCommit } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

interface GitHistoryPanelProps {
  projectId: string;
}

/**
 * Git 提交历史面板，支持无限滚动加载更多
 * Git commit history panel with infinite scroll.
 */
export function GitHistoryPanel({ projectId }: GitHistoryPanelProps) {
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
    } catch (err) {
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
            <div key={commit.hash} className="git-history-item">
              <span className="git-history-hash">
                {commit.hash.slice(0, 7)}
              </span>
              <span className="git-history-message">
                {commit.message}
              </span>
              <span className="git-history-meta">
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

/** 格式化相对时间 / Format relative time */
function formatRelativeTime(isoDate: string): string {
  const date = new Date(isoDate);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  if (diffHour < 24) return `${diffHour}h ago`;
  if (diffDay < 30) return `${diffDay}d ago`;
  if (diffDay < 365) return `${Math.floor(diffDay / 30)}mo ago`;
  return `${Math.floor(diffDay / 365)}y ago`;
}