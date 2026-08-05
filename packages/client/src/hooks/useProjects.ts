import { useEffect, useMemo } from "react";
import { api } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  activityBus,
  type ProcessStateEvent,
  type SessionCreatedEvent,
  type SessionStatusEvent,
} from "../lib/activityBus";
import {
  createClientQueryKey,
  type ClientQueryRequestContext,
} from "../lib/clientQueryController";
import {
  useProjectCollectionRecord,
  useProjectCollectionRecords,
} from "../lib/clientSummaryStore";
import { isRemoteClient } from "../lib/connection";
import { useRetainedClientQuery } from "./useRetainedClientQuery";

const PROJECTS_QUERY_KEY = createClientQueryKey({
  endpoint: "projects",
});
const PROJECTS_REVALIDATE_EVENTS = [
  "refresh",
  "reconnect",
  "process-state-changed",
  "session-status-changed",
  "session-created",
] as const;

type ProjectsResponse = Awaited<ReturnType<typeof api.getProjects>>;
type ProjectResponse = Awaited<ReturnType<typeof api.getProject>>;
interface ProjectQueryMeta {
  projectId: string | undefined;
}

function useRemoteReady(): boolean {
  const remoteConnection = useOptionalRemoteConnection();
  return (
    !isRemoteClient() ||
    (remoteConnection !== null && remoteConnection.connection !== null)
  );
}

/**
 * Fetch a single project by ID.
 */
export function useProject(projectId: string | undefined) {
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const project = useProjectCollectionRecord(projectId) ?? null;
  const ready = useRemoteReady();
  const queryKey = useMemo(
    () =>
      createClientQueryKey({
        endpoint: "project",
        projectId: projectId ?? null,
      }),
    [projectId],
  );
  const enabled = Boolean(projectId);

  const {
    loading,
    error,
    scheduleRevalidation,
  } = useRetainedClientQuery<ProjectResponse>({
    sourceKey,
    key: queryKey,
    // The selected project is one of the facts the route needs to paint.
    bootstrapTier: "route",
    enabled,
    ready,
    hasData: project !== null,
    meta: { projectId },
    revalidateOn: ["refresh", "reconnect"],
    fetcher: (context) => {
      const requestProjectId = (context.meta as ProjectQueryMeta | undefined)
        ?.projectId;
      if (!requestProjectId) {
        throw new Error("Project id is required");
      }
      return api.getProject(requestProjectId);
    },
    applySnapshot: (data, context) => {
      sourceSummary.reportProjectCollectionSnapshot(
        { project: data.project },
        context.requestStartedAt,
      );
    },
  });

  useEffect(() => {
    if (!projectId) {
      return undefined;
    }

    const maybeRefresh = (
      event: ProcessStateEvent | SessionStatusEvent | SessionCreatedEvent,
    ) => {
      const changedProjectId =
        "session" in event ? event.session.projectId : event.projectId;
      if (changedProjectId === projectId) {
        scheduleRevalidation();
      }
    };

    const unsubscribeProcess = activityBus.on(
      "process-state-changed",
      maybeRefresh,
    );
    const unsubscribeStatus = activityBus.on(
      "session-status-changed",
      maybeRefresh,
    );
    const unsubscribeCreated = activityBus.on("session-created", maybeRefresh);

    return () => {
      unsubscribeProcess();
      unsubscribeStatus();
      unsubscribeCreated();
    };
  }, [projectId, scheduleRevalidation]);

  return useMemo(
    () => ({ project, loading, error }),
    [project, loading, error],
  );
}

export function useProjects() {
  const runtime = useCurrentSourceRuntime();
  const sourceKey = runtime.sourceKey;
  const sourceSummary = runtime.summary;
  const projects = useProjectCollectionRecords();
  const ready = useRemoteReady();
  const { loading, error, refetch } = useRetainedClientQuery<ProjectsResponse>({
    sourceKey,
    key: PROJECTS_QUERY_KEY,
    bootstrapTier: "navigation",
    ready,
    hasData: projects.length > 0,
    revalidateOn: PROJECTS_REVALIDATE_EVENTS,
    fetcher: () => api.getProjects(),
    applySnapshot: (data, context: ClientQueryRequestContext) => {
      sourceSummary.reportProjectsCollectionSnapshot(
        { projects: data.projects },
        context.requestStartedAt,
      );
    },
  });

  return { projects, loading, error, refetch };
}
