import type {
  GitFileChange,
  GitStatusInfo,
  GitUntrackedFileListResult,
} from "@yep-anywhere/shared";
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
import { activityBus } from "../lib/activityBus";
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

const SAFETY_REFRESH_INTERVAL_MS = 30_000;
const ACTIVITY_REFRESH_DELAY_MS = 750;
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
  useUntrackedCache: boolean,
  omitUntracked: boolean,
): RouteRetentionKeyInput {
  return {
    sourceKey,
    routeId: useUntrackedCache
      ? "git-status:data:cached-untracked"
      : omitUntracked
        ? "git-status:data:no-untracked"
        : "git-status:data",
    projectId,
  };
}

function useGitStatusSnapshot(
  sourceKey: ClientSummarySourceKey,
  projectId: string | undefined,
  useUntrackedCache: boolean,
  omitUntracked: boolean,
): GitStatusInfo | null {
  const retentionKey = useMemo(
    () =>
      projectId
        ? getGitStatusRetentionKey(
            sourceKey,
            projectId,
            useUntrackedCache,
            omitUntracked,
          )
        : null,
    [sourceKey, projectId, useUntrackedCache, omitUntracked],
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

export function useGitStatus(
  projectId: string | undefined,
  options: {
    omitUntracked?: boolean;
    poll?: boolean;
    useUntrackedCache?: boolean;
  } = {},
) {
  const sourceKey = useClientSummarySourceKey();
  const ready = useRemoteReady();
  const useUntrackedCache = options.useUntrackedCache === true;
  const omitUntracked = options.omitUntracked === true;
  const statusSnapshot = useGitStatusSnapshot(
    sourceKey,
    projectId,
    useUntrackedCache,
    omitUntracked,
  );
  const [untrackedFiles, setUntrackedFiles] =
    useState<GitUntrackedFileListResult | null>(null);
  const gitStatus = useMemo(
    () =>
      mergeCachedUntracked(statusSnapshot, untrackedFiles, useUntrackedCache),
    [statusSnapshot, untrackedFiles, useUntrackedCache],
  );
  const [statusLoading, setStatusLoading] = useState(
    () => Boolean(projectId) && gitStatus === null,
  );
  const [statusError, setStatusError] = useState<Error | null>(null);
  const [untrackedError, setUntrackedError] = useState<Error | null>(null);
  const mountedRef = useRef(true);
  const requestSequenceRef = useRef(0);
  const untrackedRequestSequenceRef = useRef(0);
  const untrackedInFlightRef =
    useRef<Promise<GitUntrackedFileListResult> | null>(null);
  const gitStatusRef = useRef(gitStatus);
  const untrackedFilesRef = useRef(untrackedFiles);
  const payloadStateRef = useRef({
    queryKey: "",
    present: false,
  });
  const queryKey = useMemo(
    () =>
      createClientQueryKey({
        endpoint: useUntrackedCache
          ? "git-status:cached-untracked"
          : omitUntracked
            ? "git-status:no-untracked"
            : "git-status",
        projectId: projectId ?? null,
      }),
    [omitUntracked, projectId, useUntrackedCache],
  );

  gitStatusRef.current = gitStatus;
  untrackedFilesRef.current = untrackedFiles;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    void projectId;
    void sourceKey;
    void useUntrackedCache;
    void omitUntracked;
    untrackedRequestSequenceRef.current += 1;
    untrackedInFlightRef.current = null;
    setUntrackedFiles(null);
    setUntrackedError(null);
  }, [omitUntracked, projectId, sourceKey, useUntrackedCache]);

  useEffect(() => {
    void sourceKey;
    setStatusError(null);
    setStatusLoading(Boolean(projectId) && statusSnapshot === null);
  }, [projectId, sourceKey, statusSnapshot]);

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }
    return retainClientQuery({ sourceKey, key: queryKey });
  }, [projectId, queryKey, sourceKey]);

  const fetchUntrackedFiles = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      if (
        !projectId ||
        !ready ||
        !useUntrackedCache ||
        statusSnapshot?.isGitRepo !== true
      ) {
        return;
      }
      const requestId = ++untrackedRequestSequenceRef.current;
      if (!background) setUntrackedError(null);
      const existingRequest = untrackedInFlightRef.current;
      const request = existingRequest ?? api.listGitUntrackedFiles(projectId);
      if (!existingRequest) untrackedInFlightRef.current = request;
      try {
        const result = await request;
        if (
          mountedRef.current &&
          requestId === untrackedRequestSequenceRef.current
        ) {
          setUntrackedFiles(result);
          setUntrackedError(null);
        }
      } catch (err) {
        if (
          mountedRef.current &&
          requestId === untrackedRequestSequenceRef.current &&
          (!background || untrackedFilesRef.current === null)
        ) {
          setUntrackedError(
            err instanceof Error ? err : new Error(String(err)),
          );
        }
      } finally {
        if (untrackedInFlightRef.current === request) {
          untrackedInFlightRef.current = null;
        }
      }
    },
    [projectId, ready, statusSnapshot?.isGitRepo, useUntrackedCache],
  );

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
        setStatusLoading(true);
      }
      if (!background) {
        setStatusError(null);
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
          getGitStatusRetentionKey(
            context.sourceKey,
            requestProjectId,
            useUntrackedCache,
            omitUntracked,
          ),
          data,
          { ttlMs: GIT_STATUS_TTL_MS },
        );
      };

      const fetcher = (context: ClientQueryRequestContext) => {
        const requestProjectId = (context.meta as GitStatusQueryMeta).projectId;
        if (!requestProjectId) {
          throw new Error("Project id is required");
        }
        return api.getGitStatus(requestProjectId, {
          ...(omitUntracked ? { omitUntracked: true } : {}),
          ...(useUntrackedCache ? { useUntrackedCache: true } : {}),
        });
      };

      try {
        const settlement = await ensureClientQuery({
          sourceKey,
          key: queryKey,
          force: force || !hasSnapshot,
          meta,
          fetcher,
          applySnapshot,
        });
        if (!mountedRef.current || requestId !== requestSequenceRef.current) {
          return;
        }
        if (settlement.status !== "obsolete") {
          setStatusError(null);
        }
      } catch (err) {
        if (!mountedRef.current || requestId !== requestSequenceRef.current) {
          return;
        }
        if (!background || !gitStatusRef.current) {
          setStatusError(err instanceof Error ? err : new Error(String(err)));
        }
      } finally {
        if (mountedRef.current && requestId === requestSequenceRef.current) {
          setStatusLoading(false);
        }
      }
    },
    [omitUntracked, projectId, queryKey, ready, sourceKey, useUntrackedCache],
  );

  useEffect(() => {
    if (!projectId || !ready) return;
    void fetchStatus({ background: gitStatusRef.current !== null });
  }, [fetchStatus, projectId, ready]);

  useEffect(() => {
    const previous = payloadStateRef.current;
    const present = statusSnapshot !== null;
    payloadStateRef.current = { queryKey, present };
    if (
      previous.queryKey === queryKey &&
      previous.present &&
      !present &&
      projectId &&
      ready &&
      document.visibilityState === "visible" &&
      document.hasFocus()
    ) {
      void fetchStatus();
    }
  }, [fetchStatus, projectId, queryKey, ready, statusSnapshot]);

  useEffect(() => {
    if (statusSnapshot?.isGitRepo !== true) return;
    void fetchUntrackedFiles({
      background: untrackedFilesRef.current !== null,
    });
  }, [fetchUntrackedFiles, statusSnapshot?.isGitRepo]);

  useEffect(() => {
    if (!projectId || !ready || options.poll === false) return;

    let eligible = false;
    let eligibilityInitialized = false;
    let safetyRefreshId: ReturnType<typeof setInterval> | null = null;
    let activityRefreshId: ReturnType<typeof setTimeout> | null = null;

    const refreshInBackground = () => {
      void fetchStatus({ force: true, background: true });
      void fetchUntrackedFiles({ background: true });
    };

    const stopSafetyRefresh = () => {
      if (safetyRefreshId) {
        clearInterval(safetyRefreshId);
        safetyRefreshId = null;
      }
    };

    const startSafetyRefresh = () => {
      if (safetyRefreshId) return;
      safetyRefreshId = setInterval(
        refreshInBackground,
        SAFETY_REFRESH_INTERVAL_MS,
      );
    };

    const cancelActivityRefresh = () => {
      if (activityRefreshId) {
        clearTimeout(activityRefreshId);
        activityRefreshId = null;
      }
    };

    const restartSafetyRefresh = () => {
      stopSafetyRefresh();
      if (eligible) startSafetyRefresh();
    };

    const scheduleActivityRefresh = () => {
      if (!eligible) return;
      cancelActivityRefresh();
      activityRefreshId = setTimeout(() => {
        activityRefreshId = null;
        refreshInBackground();
        restartSafetyRefresh();
      }, ACTIVITY_REFRESH_DELAY_MS);
    };

    const updateEligibility = () => {
      const nextEligible =
        document.visibilityState === "visible" && document.hasFocus();
      if (eligibilityInitialized && nextEligible === eligible) return;
      const shouldRefresh = eligibilityInitialized && nextEligible;
      eligibilityInitialized = true;
      eligible = nextEligible;
      if (eligible) {
        if (shouldRefresh) refreshInBackground();
        startSafetyRefresh();
      } else {
        stopSafetyRefresh();
        cancelActivityRefresh();
      }
    };

    const unsubscribeProcessState = activityBus.onSource(
      sourceKey,
      "process-state-changed",
      (event) => {
        if (event.projectId === projectId && event.activity !== "in-turn") {
          scheduleActivityRefresh();
        }
      },
    );
    const unsubscribeReconnect = activityBus.onSource(
      sourceKey,
      "reconnect",
      scheduleActivityRefresh,
    );

    updateEligibility();
    document.addEventListener("visibilitychange", updateEligibility);
    window.addEventListener("focus", updateEligibility);
    window.addEventListener("blur", updateEligibility);

    return () => {
      eligible = false;
      stopSafetyRefresh();
      cancelActivityRefresh();
      unsubscribeProcessState();
      unsubscribeReconnect();
      document.removeEventListener("visibilitychange", updateEligibility);
      window.removeEventListener("focus", updateEligibility);
      window.removeEventListener("blur", updateEligibility);
    };
  }, [
    fetchStatus,
    fetchUntrackedFiles,
    options.poll,
    projectId,
    ready,
    sourceKey,
  ]);

  const refetch = useCallback(async () => {
    await Promise.all([
      fetchStatus({
        force: true,
        background: gitStatusRef.current !== null,
      }),
      fetchUntrackedFiles({
        background: untrackedFilesRef.current !== null,
      }),
    ]);
  }, [fetchStatus, fetchUntrackedFiles]);

  const waitingForUntracked =
    useUntrackedCache &&
    statusSnapshot?.isGitRepo === true &&
    untrackedFiles === null &&
    untrackedError === null;
  return {
    gitStatus,
    untrackedFiles,
    loading: statusLoading || waitingForUntracked,
    error: statusError ?? untrackedError,
    refetch,
  };
}

function mergeCachedUntracked(
  status: GitStatusInfo | null,
  untracked: GitUntrackedFileListResult | null,
  enabled: boolean,
): GitStatusInfo | null {
  if (!enabled || status?.isGitRepo === false) return status;
  if (!status || !untracked) return null;

  const untrackedRows: GitFileChange[] = [
    ...untracked.files.map((path) => ({
      path,
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
      ...(untracked.lastEditors?.[path]
        ? { lastEditor: untracked.lastEditors[path] }
        : {}),
    })),
    ...untracked.folders.map(({ path }) => ({
      path,
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    })),
  ];
  const trackedRows = status.files.filter((file) => file.status !== "?");
  const files = [...trackedRows, ...untrackedRows];
  return { ...status, files, isClean: files.length === 0 };
}
