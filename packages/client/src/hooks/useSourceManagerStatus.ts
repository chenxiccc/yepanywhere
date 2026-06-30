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
 *
 * stale-while-revalidate：切换项目时不清空旧数据，先显示上次缓存的状态避免闪烁，
 * 后台刷新到达后覆盖。写操作（commit/switch/push 等）通过 applyStatus 直接喂入
 * 服务端写端点返回的新鲜 status，无需额外 refetch。
 *
 * stale-while-revalidate: on project switch keep the last cached status to avoid
 * a loading flash, then overwrite once the background refresh arrives. Write
 * actions (commit/switch/push etc.) feed the fresh status returned by the server
 * write endpoint via applyStatus, avoiding an extra refetch.
 */
import type { SourceManagerStatusInfo } from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";

const POLL_INTERVAL_MS = 12000;

// 模块级 SWR 缓存：projectId -> 上次 status。切换项目时先回显，避免白屏闪烁。
// Module-level SWR cache: projectId -> last status. Replayed on project switch
// to avoid a blank flash.
const statusCache = new Map<string, SourceManagerStatusInfo>();

export function useSourceManagerStatus(projectId: string | undefined) {
  const [gitStatus, setGitStatus] = useState<SourceManagerStatusInfo | null>(
    () => (projectId ? (statusCache.get(projectId) ?? null) : null),
  );
  const [loading, setLoading] = useState(
    () => !(projectId && statusCache.has(projectId)),
  );
  const [error, setError] = useState<Error | null>(null);
  const projectIdRef = useRef(projectId);

  const fetchStatus = useCallback(async () => {
    if (!projectId) return;
    try {
      // 本分支 status 端点，返回 SourceManagerStatusInfo（含 stashes/latestLocalCommit/remote）
      // Branch status endpoint, returns SourceManagerStatusInfo (with stashes/latestLocalCommit/remote)
      const data = await api.getSourceManagerStatus(projectId);
      statusCache.set(projectId, data);
      setGitStatus(data);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // 写操作后直接应用服务端返回的新鲜 status，无需 refetch / Apply fresh status
  // returned by server write endpoint after a write action, no refetch needed.
  const applyStatus = useCallback(
    (status: SourceManagerStatusInfo) => {
      if (!projectId) return;
      statusCache.set(projectId, status);
      setGitStatus(status);
      setError(null);
      setLoading(false);
    },
    [projectId],
  );

  // 切换项目：不清空 gitStatus（SWR 回显缓存），仅重置 loading/error 并 fetch
  // Project switch: don't clear gitStatus (SWR replays cache), just reset
  // loading/error and fetch.
  useEffect(() => {
    if (projectIdRef.current !== projectId) {
      projectIdRef.current = projectId;
      if (projectId && statusCache.has(projectId)) {
        setGitStatus(statusCache.get(projectId) ?? null);
        setLoading(false);
      } else {
        setGitStatus(null);
        setLoading(true);
      }
      setError(null);
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

  return { gitStatus, loading, error, refetch: fetchStatus, applyStatus };
}
