import {
  type ProjectQueueItemSummary,
  type ProjectQueueListResponse,
  type ProjectQueueProjectStatus,
  type ProjectQueueRecoveredSessionQueueSummary,
  type ProjectQueueResponse,
  getSessionDisplayTitle,
  isUrlProjectId,
} from "@yep-anywhere/shared";
import type { SessionMetadataService } from "../metadata/index.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ProjectQueueService } from "../services/ProjectQueueService.js";
import type { ProjectQueueScheduler } from "../services/ProjectQueueScheduler.js";
import type {
  PersistedSessionQueuedMessage,
  SessionQueuePersistenceService,
} from "../services/SessionQueuePersistenceService.js";
import {
  findSessionListSummaryAcrossProviders,
  type ProviderResolutionDeps,
} from "../sessions/provider-resolution.js";
import type { Project } from "../supervisor/types.js";

interface ProjectQueueTitleDeps extends Partial<ProviderResolutionDeps> {
  scanner?: ProjectScanner;
  sessionMetadataService?: SessionMetadataService;
}

export interface ProjectQueueRoutesDeps extends ProjectQueueTitleDeps {
  scanner: ProjectScanner;
  projectQueueService: ProjectQueueService;
  projectQueueScheduler?: Pick<ProjectQueueScheduler, "getProjectStatus">;
}

export type GlobalProjectQueueRoutesDeps = ProjectQueueTitleDeps & {
  projectQueueService: ProjectQueueService;
  projectQueueScheduler?: Pick<
    ProjectQueueScheduler,
    "getProjectStatus" | "promoteNow"
  >;
  sessionQueuePersistenceService?: SessionQueuePersistenceService;
};

function isRecoveredPatientQueueItem(
  item: PersistedSessionQueuedMessage,
): boolean {
  return item.kind === "patient" && item.status === "paused-after-restart";
}

function summarizeRecoveredSessionQueue(
  item: PersistedSessionQueuedMessage,
  sessionMetadataService: SessionMetadataService | undefined,
): ProjectQueueRecoveredSessionQueueSummary {
  const attachmentCount =
    (item.message.attachments?.length ?? 0) +
    (item.message.images?.length ?? 0) +
    (item.message.documents?.length ?? 0);
  const tempId = item.message.tempId ?? item.source?.tempId;
  const sessionTitle = sessionMetadataService?.getMetadata(
    item.sessionId,
  )?.customTitle;

  return {
    id: item.id,
    ...(tempId ? { tempId } : {}),
    content: item.message.text,
    timestamp: item.queuedAt,
    ...(item.message.attachments?.length
      ? { attachments: item.message.attachments }
      : {}),
    ...(attachmentCount > 0 ? { attachmentCount } : {}),
    ...(item.message.metadata ? { metadata: item.message.metadata } : {}),
    kind: "patient",
    status: "paused-after-restart",
    sessionId: item.sessionId,
    projectId: item.projectId,
    queuedAt: item.queuedAt,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    ...(sessionTitle ? { sessionTitle } : {}),
  };
}

function listRecoveredSessionQueues(
  deps: GlobalProjectQueueRoutesDeps,
): ProjectQueueRecoveredSessionQueueSummary[] {
  return (deps.sessionQueuePersistenceService?.list() ?? [])
    .filter(isRecoveredPatientQueueItem)
    .sort((left, right) => {
      const project = left.projectId.localeCompare(right.projectId);
      if (project !== 0) return project;
      const session = left.sessionId.localeCompare(right.sessionId);
      if (session !== 0) return session;
      const queued = left.queuedAt.localeCompare(right.queuedAt);
      return queued !== 0 ? queued : left.id.localeCompare(right.id);
    })
    .map((item) =>
      summarizeRecoveredSessionQueue(item, deps.sessionMetadataService),
    );
}

function hasTitleResolutionDeps(
  deps: ProjectQueueTitleDeps,
): deps is ProjectQueueTitleDeps &
  Pick<ProviderResolutionDeps, "readerFactory"> {
  return typeof deps.readerFactory === "function";
}

function hasDisplayMetadataDeps(deps: ProjectQueueTitleDeps): boolean {
  return !!deps.sessionMetadataService || hasTitleResolutionDeps(deps);
}

function resolveTargetTitles(
  sessionId: string,
  summary: { title?: string | null; fullTitle?: string | null } | null,
  deps: ProjectQueueTitleDeps,
): Pick<ProjectQueueItemSummary, "targetTitle" | "targetFullTitle"> {
  const customTitle =
    deps.sessionMetadataService?.getMetadata(sessionId)?.customTitle;
  const title = summary?.title ?? null;
  return {
    targetTitle:
      customTitle !== undefined || title !== null
        ? getSessionDisplayTitle({ customTitle, title })
        : null,
    targetFullTitle: customTitle ?? summary?.fullTitle ?? null,
  };
}

function buildProviderResolutionDeps(
  deps: ProjectQueueTitleDeps & Pick<ProviderResolutionDeps, "readerFactory">,
): ProviderResolutionDeps {
  const resolutionDeps: ProviderResolutionDeps = {
    readerFactory: deps.readerFactory,
  };
  if (deps.sessionIndexService) {
    resolutionDeps.sessionIndexService = deps.sessionIndexService;
  }
  if (deps.codexSessionsDir) {
    resolutionDeps.codexSessionsDir = deps.codexSessionsDir;
  }
  if (deps.codexReaderFactory) {
    resolutionDeps.codexReaderFactory = deps.codexReaderFactory;
  }
  if (deps.geminiSessionsDir) {
    resolutionDeps.geminiSessionsDir = deps.geminiSessionsDir;
  }
  if (deps.geminiReaderFactory) {
    resolutionDeps.geminiReaderFactory = deps.geminiReaderFactory;
  }
  if (deps.geminiHashToCwd) {
    resolutionDeps.geminiHashToCwd = deps.geminiHashToCwd;
  }
  if (deps.grokSessionsDir) {
    resolutionDeps.grokSessionsDir = deps.grokSessionsDir;
  }
  if (deps.grokReaderFactory) {
    resolutionDeps.grokReaderFactory = deps.grokReaderFactory;
  }
  if (deps.piSessionsDir) {
    resolutionDeps.piSessionsDir = deps.piSessionsDir;
  }
  if (deps.piReaderFactory) {
    resolutionDeps.piReaderFactory = deps.piReaderFactory;
  }
  return resolutionDeps;
}

async function enrichProjectQueueItem(
  project: Project | null,
  item: ProjectQueueItemSummary,
  deps: ProjectQueueTitleDeps,
): Promise<ProjectQueueItemSummary> {
  if (
    item.target.type !== "existing-session" ||
    !hasDisplayMetadataDeps(deps)
  ) {
    return item;
  }

  if (!project || !hasTitleResolutionDeps(deps)) {
    const titles = resolveTargetTitles(item.target.sessionId, null, deps);
    return titles.targetTitle !== null || titles.targetFullTitle !== null
      ? { ...item, ...titles }
      : item;
  }

  try {
    const resolved = await findSessionListSummaryAcrossProviders(
      project,
      item.target.sessionId,
      project.id,
      buildProviderResolutionDeps(deps),
      item.target.provider,
    );
    return {
      ...item,
      ...resolveTargetTitles(
        item.target.sessionId,
        resolved?.summary ?? null,
        deps,
      ),
    };
  } catch {
    return {
      ...item,
      ...resolveTargetTitles(item.target.sessionId, null, deps),
    };
  }
}

async function enrichProjectQueueItems(
  project: Project,
  items: ProjectQueueItemSummary[],
  deps: ProjectQueueTitleDeps,
): Promise<ProjectQueueItemSummary[]> {
  if (!hasDisplayMetadataDeps(deps)) {
    return items;
  }
  return Promise.all(
    items.map((item) => enrichProjectQueueItem(project, item, deps)),
  );
}

async function resolveProjectForQueueItem(
  item: ProjectQueueItemSummary,
  deps: GlobalProjectQueueRoutesDeps,
  projectCache: Map<string, Promise<Project | null>>,
): Promise<Project | null> {
  if (!deps.scanner) return null;
  let projectPromise = projectCache.get(item.projectId);
  if (!projectPromise) {
    projectPromise = deps.scanner
      .getOrCreateProject(item.projectId)
      .catch(() => null);
    projectCache.set(item.projectId, projectPromise);
  }
  return projectPromise;
}

async function enrichGlobalProjectQueueItems(
  items: ProjectQueueItemSummary[],
  deps: GlobalProjectQueueRoutesDeps,
): Promise<ProjectQueueItemSummary[]> {
  if (!hasDisplayMetadataDeps(deps)) {
    return items;
  }
  const projectCache = new Map<string, Promise<Project | null>>();
  return Promise.all(
    items.map(async (item) => {
      const project =
        deps.scanner && hasTitleResolutionDeps(deps)
          ? await resolveProjectForQueueItem(item, deps, projectCache)
          : null;
      return enrichProjectQueueItem(project, item, deps);
    }),
  );
}

async function projectStatusesForIds(
  projectIds: Iterable<string>,
  deps: Pick<
    GlobalProjectQueueRoutesDeps | ProjectQueueRoutesDeps,
    "projectQueueScheduler"
  >,
): Promise<Record<string, ProjectQueueProjectStatus> | undefined> {
  const scheduler = deps.projectQueueScheduler;
  if (!scheduler) return undefined;
  const statuses: Record<string, ProjectQueueProjectStatus> = {};
  for (const projectId of new Set(projectIds)) {
    if (!isUrlProjectId(projectId)) continue;
    statuses[projectId] = await scheduler.getProjectStatus(projectId);
  }
  return statuses;
}

export async function projectQueueResponse(
  project: Project,
  deps: ProjectQueueRoutesDeps,
): Promise<ProjectQueueResponse> {
  const queue = deps.projectQueueService.listProject(project.id);
  const projectStatuses = await projectStatusesForIds([project.id], deps);
  return {
    ...queue,
    items: await enrichProjectQueueItems(project, queue.items, deps),
    projectStatuses,
  };
}

export async function globalQueueResponse(
  deps: GlobalProjectQueueRoutesDeps,
  dispatchState = deps.projectQueueService.getDispatchState(),
): Promise<ProjectQueueListResponse> {
  const items = deps.projectQueueService.listAll();
  const recoveredSessionQueues = listRecoveredSessionQueues(deps);
  const projectStatuses = await projectStatusesForIds(
    [
      ...items.map((item) => item.projectId),
      ...recoveredSessionQueues.map((item) => item.projectId),
    ],
    deps,
  );
  return {
    items: await enrichGlobalProjectQueueItems(items, deps),
    dispatchState,
    recoveredSessionQueues,
    projectStatuses,
  };
}
