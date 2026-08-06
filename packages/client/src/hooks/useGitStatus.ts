import type { GitStatusInfo } from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { api } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import {
  createClientQueryKey,
  ensureClientQuery,
  retainClientQuery,
  type ClientQueryRequestContext,
} from "../lib/clientQueryController";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import { isRemoteClient } from "../lib/connection";
import {
  readRouteRetention,
  subscribeRouteRetention,
  writeRouteRetention,
  type RouteRetentionKeyInput,
} from "../lib/routeRetention";

const POLL_INTERVAL_MS = 5000;
const GIT_STATUS_STALE_MS = 5000;
const GIT_STATUS_TTL_MS = 60 * 1000;

interface GitStatusQueryMeta {
  projectId: string | undefined;
}

function useRemoteReady(): boolean {
  const remoteConnection = useOptionalRemoteConnection();
  return (
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null)
  );
}

function getGitStatusRetentionKey(
  sourceKey: ClientSummarySourceKey,
  projectId: string,
): RouteRetentionKeyInput {
  return {
    sourceKey,
    routeId: "git-status:data",
    projectId,
  };
}

function useGitStatusSnapshot(
  sourceKey: ClientSummarySourceKey,
  projectId: string | undefined,
): GitStatusInfo | null {
  const retentionKey = useMemo(
    () => (projectId ? getGitStatusRetentionKey(sourceKey, projectId) : null),
    [sourceKey, projectId],
  );

  return useSyncExternalStore(
    subscribeRouteRetention,
    () =>
      retentionKey
        ? readRouteRetention<GitStatusInfo>(retentionKey, {
            touch: false,
            recordDiagnostics: false,
          })
        : null,
    () => null,
  );
}

export function useGitStatus(projectId: string | undefined) {
  const sourceKey = useClientSummarySourceKey();
  const ready = useRemoteReady();
  const gitStatus = useGitStatusSnapshot(sourceKey, projectId);
  const [loading, setLoading] = useState(
    () => Boolean(projectId) && gitStatus === null,
  );
  const [error, setError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const gitStatusRef = useRef(gitStatus);
  const queryKey = useMemo(
    () =>
      createClientQueryKey({
        endpoint: "git-status",
        projectId: projectId ?? null,
      }),
    [projectId],
  );

  gitStatusRef.current = gitStatus;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void sourceKey;
    setError(null);
    setLoading(Boolean(projectId) && gitStatus === null);
  }, [gitStatus, projectId, sourceKey]);

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }
    return retainClientQuery({ sourceKey, key: queryKey });
  }, [projectId, queryKey, sourceKey]);

  const fetchStatus = useCallback(
    async ({
      force = false,
      background = false,
    }: {
      force?: boolean;
      background?: boolean;
    } = {}) => {
      if (!projectId || !ready) return;

      const requestId = ++requestSequenceRef.current;
      const hasSnapshot = gitStatusRef.current !== null;
      if (!background && !hasSnapshot) {
        setLoading(true);
      }
      if (!background) {
        setError(null);
      }

      const meta: GitStatusQueryMeta = { projectId };
      const applySnapshot = (
        data: GitStatusInfo,
        context: ClientQueryRequestContext,
      ) => {
        const requestProjectId = (context.meta as GitStatusQueryMeta).projectId;
        if (!requestProjectId) {
          return;
        }
        writeRouteRetention(
          getGitStatusRetentionKey(context.sourceKey, requestProjectId),
          data,
          { ttlMs: GIT_STATUS_TTL_MS },
        );
      };

      const fetcher = (context: ClientQueryRequestContext) => {
        const requestProjectId = (context.meta as GitStatusQueryMeta).projectId;
        if (!requestProjectId) {
          throw new Error("Project id is required");
        }
        return api.getGitStatus(requestProjectId);
      };

      try {
        const settlement = await ensureClientQuery({
          sourceKey,
          key: queryKey,
          staleTimeMs: GIT_STATUS_STALE_MS,
          force,
          meta,
          fetcher,
          applySnapshot,
        });
        if (!mountedRef.current || requestId !== requestSequenceRef.current) {
          return;
        }
        if (settlement.status !== "obsolete") {
          setError(null);
        }
      } catch (err) {
        if (!mountedRef.current || requestId !== requestSequenceRef.current) {
          return;
        }
        if (!background || !gitStatusRef.current) {
          setError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (mountedRef.current && requestId === requestSequenceRef.current) {
          setLoading(false);
        }
      }
    },
    [projectId, queryKey, ready, sourceKey],
  );

  useEffect(() => {
    if (!projectId || !ready) {
      return;
    }
    void fetchStatus({ background: gitStatusRef.current !== null });
  }, [fetchStatus, projectId, ready]);

  // Poll while visible.
  useEffect(() => {
    if (!projectId || !ready) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const refreshInBackground = () => {
      void fetchStatus({ force: true, background: true });
    };

    const startPolling = () => {
      if (intervalId) return;
      intervalId = setInterval(refreshInBackground, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        refreshInBackground();
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
  }, [fetchStatus, projectId, ready]);

  const refetch = useCallback(async () => {
    await fetchStatus({
      force: true,
      background: gitStatusRef.current !== null,
    });
  }, [fetchStatus]);

  return { gitStatus, loading, error, refetch };
}
