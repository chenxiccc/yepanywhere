/**
 * Source manager status polling hook / 源码管理状态轮询 hook
 *
 * 本分支独立于上游 useGitStatus（上游返回 GitStatusInfo，被上游基础页用；
 * 本分支页需要 SourceManagerStatusInfo 的 stashes/latestLocalCommit/remote 字段）。
 * 复用上游 api.getGitStatus（运行时端点返回本分支字段），用类型断言转为本分支类型。
 *
 * Independent of upstream useGitStatus (upstream returns GitStatusInfo used by
 * the upstream basic page; the source-manager page needs SourceManagerStatusInfo
 * fields stashes/latestLocalCommit/remote). Reuses upstream api.getGitStatus
 * (the endpoint returns branch fields at runtime), cast to the branch type.
 */
import type { SourceManagerStatusInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

const POLL_INTERVAL_MS = 5000;

export function useSourceManagerStatus(projectId: string | undefined) {
  const [gitStatus, setGitStatus] = useState<SourceManagerStatusInfo | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const projectIdRef = useRef(projectId);

  const fetchStatus = useCallback(async () => {
    if (!projectId) return;
    try {
      // 本分支 status 端点，返回 SourceManagerStatusInfo（含 stashes/latestLocalCommit/remote）
      // Branch status endpoint, returns SourceManagerStatusInfo (with stashes/latestLocalCommit/remote)
      const data = await api.getSourceManagerStatus(projectId);
      setGitStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Reset on projectId change + initial fetch
  useEffect(() => {
    if (projectIdRef.current !== projectId) {
      setLoading(true);
      setGitStatus(null);
      setError(null);
      projectIdRef.current = projectId;
    }
    fetchStatus();
  }, [fetchStatus, projectId]);

  // Poll while visible
  useEffect(() => {
    if (!projectId) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(fetchStatus, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        fetchStatus();
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === "visible") {
      startPolling();
    }

    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      stopPolling();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [projectId, fetchStatus]);

  return { gitStatus, loading, error, refetch: fetchStatus };
}
