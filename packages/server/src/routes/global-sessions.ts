/**
 * Global sessions route - returns all sessions across all projects.
 *
 * Unlike the inbox route which categorizes sessions into tiers,
 * this returns a flat list suitable for navigation/sidebar use.
 */

import type { ProviderName, WorkstreamId } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import type { SessionIndexListOptions } from "../indexes/types.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import { isDetachedProjectPath } from "../projects/paths.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { listSessionsAcrossProviders } from "../sessions/provider-resolution.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ISessionReader } from "../sessions/types.js";
import {
  applyRecapOverlayToSummary,
  getEffectiveProviderUpdatedAt,
  hasUnreadProviderContent,
} from "../sessions/recap-overlays.js";
import type { ExternalSessionTracker } from "../supervisor/ExternalSessionTracker.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
  SessionOwnership,
  SessionSummary,
} from "../supervisor/types.js";
import type { BusEvent, EventBus } from "../watcher/index.js";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import { SessionCollectionGeneration } from "../sessions/sessionCollectionGeneration.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";
import {
  getActiveSessionIndexOptions,
  isSessionAutoArchived,
} from "./session-list-options.js";

export interface GlobalSessionsDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  externalTracker?: ExternalSessionTracker;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  /** Codex scanner for checking if a project has Codex sessions */
  codexScanner?: CodexSessionScanner;
  /** Codex sessions directory (defaults to ~/.codex/sessions) */
  codexSessionsDir?: string;
  /** Optional shared Codex reader factory for cross-provider session lookups */
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  /** Gemini scanner for checking if a project has Gemini sessions */
  geminiScanner?: GeminiSessionScanner;
  /** Gemini sessions directory (defaults to ~/.gemini/tmp) */
  geminiSessionsDir?: string;
  /** Optional shared Gemini reader factory for cross-provider session lookups */
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  /** Grok sessions directory (defaults to ~/.grok/sessions) */
  grokSessionsDir?: string;
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  /** pi sessions directory (defaults to ~/.pi/agent/sessions) */
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  /** Event bus for cache invalidation */
  eventBus?: EventBus;
  /** Sessions older than this many days are hidden from default scans. 0 disables. */
  sessionAutoArchiveDays?: number;
}

export interface GlobalSessionItem {
  // From cache (cheap)
  id: string;
  title: string | null;
  fullTitle: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  provider: ProviderName;
  /** Last active model for this session (from JSONL), for list/badge display. */
  model?: string;
  // Project context
  projectId: string;
  projectName: string;
  // Enrichment (all in-memory, cheap)
  ownership: SessionOwnership;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isArchived?: boolean;
  isStarred?: boolean;
  /** True when an explicit manual termination disabled automatic resume. */
  autoResumeDisabled?: boolean;
  /** Interactive Mother session for a YA-owned `/btw` aside. */
  parentSessionId?: string;
  parentSessionKind?: "btw-aside";
  /** Source session whose provider transcript was cloned or forked. */
  forkedFromSessionId?: string;
  /** YA workstream lane for this session. Missing means the implicit main lane. */
  workstreamId?: WorkstreamId;
  /** Initial prompt text accepted by YA for new-session recovery/copy. */
  initialPrompt?: string;
  /** SSH host alias for remote execution (undefined = local) */
  executor?: string;
  /** Capped excerpt of the most recent visible agent turn or provider recap. */
  lastAgentText?: string;
}

/** Stats about all sessions (computed during full scan) */
export interface GlobalSessionStats {
  totalCount: number;
  unreadCount: number;
  starredCount: number;
  archivedCount: number;
  /** Counts per provider (non-archived only) */
  providerCounts: Partial<Record<ProviderName, number>>;
  /** Counts per executor host (non-archived only, "local" key for sessions without executor) */
  executorCounts: Record<string, number>;
}

/** Minimal project info for filter dropdowns */
export interface ProjectOption {
  id: string;
  name: string;
}

export interface GlobalSessionsResponse {
  sessions: GlobalSessionItem[];
  hasMore: boolean;
  /** Global stats computed from all sessions (not just paginated results) */
  stats: GlobalSessionStats;
  /** All projects for filter dropdown */
  projects: ProjectOption[];
  /**
   * The collection revision this response reflects. A client may send it back
   * as `knownGeneration` to get {@link GlobalSessionsUnchangedResponse} instead
   * of another full walk. Gated by `progressive-session-catalog`.
   */
  generation?: number;
}

/**
 * The answer to a conditional read whose `knownGeneration` still holds. It
 * carries no rows: the client keeps the ones it has.
 */
export interface GlobalSessionsUnchangedResponse {
  unchanged: true;
  generation: number;
}

/** Default limit for sessions per page */
const DEFAULT_LIMIT = 100;

/** Maximum allowed limit */
const MAX_LIMIT = 500;
/** Stats cache TTL in milliseconds */
const STATS_CACHE_TTL_MS = 5000;

/**
 * How much enriched collection state to retain across requests. Rows are
 * compact summaries, not transcripts; this bounds an unusually large install
 * rather than sizing an expected one.
 */
const COLLECTION_RETENTION_BYTES = 16 * 1024 * 1024;

interface CollectionRequest {
  filterProjectId?: string;
  searchQuery?: string;
  afterCursor?: string;
  includeArchived: boolean;
  starredOnly: boolean;
  includeStats: boolean;
  limit: number;
  /** The generation observed before the walk; stamped on the response. */
  generation: number;
}

function createEmptyStats(): GlobalSessionStats {
  return {
    totalCount: 0,
    unreadCount: 0,
    starredCount: 0,
    archivedCount: 0,
    providerCounts: {},
    executorCounts: {},
  };
}

export function createGlobalSessionsRoutes(deps: GlobalSessionsDeps): Hono {
  const routes = new Hono();
  let cachedStats: { value: GlobalSessionStats; timestamp: number } | null =
    null;
  let statsDirty = true;
  let inFlightStats: Promise<GlobalSessionStats> | null = null;

  const collectionGeneration = new SessionCollectionGeneration(deps.eventBus);
  const collectionWalks = new SourceVersionedSingleFlight<
    string,
    GlobalSessionsResponse
  >({
    maxRetainedBytes: COLLECTION_RETENTION_BYTES,
    estimateBytes: (value) =>
      // Row count is the term that actually varies; the constant is a rough
      // per-row summary size, not a measurement of any particular install.
      value.sessions.length * 512 + value.projects.length * 64,
  });

  const shouldInvalidateStats = (event: BusEvent): boolean => {
    switch (event.type) {
      case "file-change":
      case "session-created":
      case "session-updated":
      case "session-seen":
      case "session-metadata-changed":
        return true;
      default:
        return false;
    }
  };

  const invalidateStats = (): void => {
    statsDirty = true;
  };

  if (deps.eventBus) {
    deps.eventBus.subscribe((event) => {
      if (shouldInvalidateStats(event)) {
        invalidateStats();
      }
    });
  }

  const getDefaultListOptions = (): SessionIndexListOptions | undefined =>
    getActiveSessionIndexOptions(deps.sessionAutoArchiveDays);

  const listSessionsForProject = async (
    project: Project,
    providerCatalog: Awaited<ReturnType<typeof buildProviderProjectCatalog>>,
    options?: SessionIndexListOptions,
  ): Promise<SessionSummary[]> => {
    return listSessionsAcrossProviders(
      project,
      {
        readerFactory: deps.readerFactory,
        sessionIndexService: deps.sessionIndexService,
        codexSessionsDir: deps.codexSessionsDir,
        codexReaderFactory: deps.codexReaderFactory,
        geminiSessionsDir: deps.geminiSessionsDir,
        geminiReaderFactory: deps.geminiReaderFactory,
        geminiHashToCwd: providerCatalog.geminiHashToCwd,
        grokSessionsDir: deps.grokSessionsDir,
        grokReaderFactory: deps.grokReaderFactory,
        piSessionsDir: deps.piSessionsDir,
        piReaderFactory: deps.piReaderFactory,
      },
      providerCatalog,
      options,
    );
  };

  const computeGlobalStats = async (): Promise<GlobalSessionStats> => {
    const projects = await deps.scanner.listProjects();
    const stats: GlobalSessionStats = createEmptyStats();
    const providerCatalog = await buildProviderProjectCatalog({
      projects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });

    const statsListOptions = getDefaultListOptions();
    const statsAutoArchiveAfterMs = statsListOptions?.activeAfterMs;

    for (const project of projects) {
      const sessions = await listSessionsForProject(
        project,
        providerCatalog,
        statsListOptions,
      );
      for (const session of sessions) {
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const overlaidSession = deps.sessionMetadataService
          ? applyRecapOverlayToSummary(
              session,
              deps.sessionMetadataService.getRecapMessages(session.id),
            )
          : session;
        const isArchived =
          metadata?.isArchived ??
          overlaidSession.isArchived ??
          isSessionAutoArchived(overlaidSession, statsAutoArchiveAfterMs);
        const isStarred = metadata?.isStarred ?? session.isStarred ?? false;
        const executor = metadata?.executor;
        const process = deps.supervisor?.getProcessForSession(session.id);
        const effectiveProviderUpdatedAt = getEffectiveProviderUpdatedAt(
          session.updatedAt,
          process,
        );

        const hasUnread =
          hasUnreadProviderContent(
            deps.notificationService,
            session.id,
            effectiveProviderUpdatedAt,
          ) ?? false;

        if (isArchived) {
          stats.archivedCount++;
        } else {
          stats.totalCount++;
          if (hasUnread) stats.unreadCount++;
          if (overlaidSession.provider) {
            stats.providerCounts[overlaidSession.provider] =
              (stats.providerCounts[overlaidSession.provider] ?? 0) + 1;
          }
          const executorKey = executor ?? "local";
          stats.executorCounts[executorKey] =
            (stats.executorCounts[executorKey] ?? 0) + 1;
        }
        if (isStarred) stats.starredCount++;
      }
    }

    return stats;
  };

  const getCachedGlobalStats = async (): Promise<GlobalSessionStats> => {
    const now = Date.now();
    const isFresh =
      cachedStats &&
      !statsDirty &&
      now - cachedStats.timestamp < STATS_CACHE_TTL_MS;
    if (isFresh && cachedStats) {
      return cachedStats.value;
    }

    if (inFlightStats) {
      return inFlightStats;
    }

    const statsPromise = computeGlobalStats()
      .then((stats) => {
        cachedStats = { value: stats, timestamp: Date.now() };
        statsDirty = false;
        return stats;
      })
      .finally(() => {
        if (inFlightStats === statsPromise) {
          inFlightStats = null;
        }
      });

    inFlightStats = statsPromise;
    return statsPromise;
  };

  // GET /api/sessions/stats - Get cached global session stats
  routes.get("/stats", async (c) => {
    const filterProjectId = c.req.query("project");
    if (filterProjectId) {
      return c.json({ stats: createEmptyStats() });
    }

    const stats = await getCachedGlobalStats();
    return c.json({ stats });
  });

  // GET /api/sessions - Get all sessions with pagination
  routes.get("/", async (c) => {
    // Parse query params
    const filterProjectId = c.req.query("project");
    const searchQuery = c.req.query("q")?.toLowerCase();
    const afterCursor = c.req.query("after");
    const includeArchived = c.req.query("includeArchived") === "true";
    const starredOnly = c.req.query("starred") === "true";
    const includeStats = c.req.query("includeStats") === "true";
    const limitParam = c.req.query("limit");
    const limit = Math.min(
      Math.max(1, Number.parseInt(limitParam || "", 10) || DEFAULT_LIMIT),
      MAX_LIMIT,
    );

    // Read before the walk, never after: a change landing mid-walk must leave
    // the client's token behind the current generation, so its next
    // conditional read is answered `changed`. Stamping the response with the
    // post-walk value would certify rows the response does not contain.
    const generation = collectionGeneration.current;
    // A cursor page is not a whole-collection read, so it never short-circuits;
    // the token only means "the collection behind an identical query is
    // unchanged", which is why the client must replay it against the same
    // parameters it received it from.
    const knownGeneration = Number.parseInt(
      c.req.query("knownGeneration") ?? "",
      10,
    );
    if (!afterCursor && collectionGeneration.matches(knownGeneration)) {
      const unchanged: GlobalSessionsUnchangedResponse = {
        unchanged: true,
        generation,
      };
      return c.json(unchanged);
    }

    return c.json(
      await readCollection({
        filterProjectId,
        searchQuery,
        afterCursor,
        includeArchived,
        starredOnly,
        includeStats,
        limit,
        generation,
      }),
    );
  });

  /**
   * One walk per (query, generation), however many tabs ask for it.
   *
   * Twenty clients reconnecting at once used to run twenty independent walks of
   * every project, and a client without `progressive-session-catalog` — which
   * cannot send a known generation — repeats its walk on every revalidation
   * forever. Retention is what keeps that ungated client's fallback a
   * performance floor rather than a penalty.
   *
   * `isCurrent` is deliberately vacuous. A generation advancing mid-walk does
   * not invalidate the answer, because the response is stamped with the
   * generation read *before* the walk: the rows are a correct snapshot for that
   * generation, and the client's next conditional read is told `changed`.
   * Discarding the completion instead would leave a busy server unable to
   * answer at all, and the retained entry is unreachable afterwards anyway
   * since the generation only moves forward.
   */
  async function readCollection(
    request: CollectionRequest,
  ): Promise<GlobalSessionsResponse> {
    const result = await collectionWalks.run({
      key: JSON.stringify([
        request.filterProjectId ?? null,
        request.searchQuery ?? null,
        request.afterCursor ?? null,
        request.includeArchived,
        request.starredOnly,
        request.includeStats,
        request.limit,
      ]),
      sourceVersion: String(request.generation),
      compute: () => walkCollection(request),
      isCurrent: () => true,
    });
    if (result.status === "stale") {
      // Unreachable while `isCurrent` is vacuous; walking again is the only
      // answer that cannot be wrong if that ever changes.
      return walkCollection(request);
    }
    return result.value;
  }

  async function walkCollection(
    request: CollectionRequest,
  ): Promise<GlobalSessionsResponse> {
    const {
      filterProjectId,
      searchQuery,
      afterCursor,
      includeArchived,
      starredOnly,
      includeStats,
      limit,
      generation,
    } = request;

    // Get all projects
    const allProjects = await deps.scanner.listProjects();

    const projectsById = new Map(allProjects.map((p) => [p.id, p]));
    // Project filtering applies to the effective YA project after session
    // metadata is read, so scan every transcript project and filter below.
    const projects = allProjects;

    // Build project options for filter dropdown (from all projects, sorted by name)
    const projectOptions: ProjectOption[] = allProjects
      .filter((project) => !isDetachedProjectPath(project.path))
      .map((p) => ({ id: p.id, name: p.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    // Collect all sessions with enriched data
    const allSessions: GlobalSessionItem[] = [];
    const providerCatalog = await buildProviderProjectCatalog({
      projects: allProjects,
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });

    const defaultListOptions = getDefaultListOptions();
    const listOptions = includeArchived ? undefined : defaultListOptions;
    const autoArchiveAfterMs = defaultListOptions?.activeAfterMs;

    for (const project of projects) {
      const sessions = await listSessionsForProject(
        project,
        providerCatalog,
        listOptions,
      );

      // Enrich each session
      for (const session of sessions) {
        // Get session metadata
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const overlaidSession = deps.sessionMetadataService
          ? applyRecapOverlayToSummary(
              session,
              deps.sessionMetadataService.getRecapMessages(session.id),
            )
          : session;
        const effectiveProjectId =
          metadata?.workingProjectId ?? session.projectId;
        if (filterProjectId && effectiveProjectId !== filterProjectId) {
          continue;
        }
        const effectiveProject =
          projectsById.get(effectiveProjectId) ?? project;

        const isArchived =
          metadata?.isArchived ??
          overlaidSession.isArchived ??
          isSessionAutoArchived(overlaidSession, autoArchiveAfterMs);
        const isStarred =
          metadata?.isStarred ?? overlaidSession.isStarred ?? false;
        const customTitle =
          metadata?.customTitle ?? overlaidSession.customTitle;
        const parentSessionId =
          metadata?.parentSessionId ?? overlaidSession.parentSessionId;
        const parentSessionKind =
          metadata?.parentSessionKind ?? overlaidSession.parentSessionKind;
        const forkedFromSessionId =
          metadata?.forkedFromSessionId ?? overlaidSession.forkedFromSessionId;
        const initialPrompt =
          metadata?.initialPrompt ?? overlaidSession.fullTitle;
        const executor = metadata?.executor;

        // Skip archived sessions unless explicitly requested
        if (isArchived && !includeArchived) continue;

        // Skip non-starred sessions if starred filter is active
        if (starredOnly && !isStarred) continue;

        // Compute status
        const process = deps.supervisor?.getProcessForSession(session.id);
        const effectiveProviderUpdatedAt = getEffectiveProviderUpdatedAt(
          session.updatedAt,
          process,
        );
        const effectiveUpdatedAt = getEffectiveProviderUpdatedAt(
          overlaidSession.updatedAt,
          process,
        );
        const hasUnread = hasUnreadProviderContent(
          deps.notificationService,
          session.id,
          effectiveProviderUpdatedAt,
        );
        const isExternal =
          deps.externalTracker?.isExternal(session.id) ?? false;

        const ownership: SessionOwnership = process
          ? {
              owner: "self",
              processId: process.id,
              permissionMode: process.permissionMode,
              appliedPermissionMode: process.appliedPermissionMode,
              modeVersion: process.modeVersion,
              recapAfterSeconds: process.recapAfterSeconds,
            }
          : isExternal
            ? { owner: "external" }
            : (session.ownership ?? { owner: "none" });

        // Get agent activity
        let pendingInputType: PendingInputType | undefined;
        let activity: AgentActivity | undefined;
        if (process) {
          const pendingRequest = process.getPendingInputRequest();
          if (pendingRequest) {
            pendingInputType =
              pendingRequest.type === "tool-approval"
                ? "tool-approval"
                : "user-question";
          }
          const state = process.state.type;
          if (state === "in-turn" || state === "waiting-input") {
            activity = state;
          } else if (state === "idle" && process.isRetainingProviderWork()) {
            // Idle but the provider still has background tasks/crons running —
            // surface as active so the sidebar shows the activity indicator.
            activity = "in-turn";
          }
        }

        // Apply search filter
        if (searchQuery) {
          const titleMatch = overlaidSession.title
            ?.toLowerCase()
            .includes(searchQuery);
          const customTitleMatch = customTitle
            ?.toLowerCase()
            .includes(searchQuery);
          const projectNameMatch = effectiveProject.name
            .toLowerCase()
            .includes(searchQuery);
          const initialPromptMatch = initialPrompt
            ?.toLowerCase()
            .includes(searchQuery);

          if (
            !titleMatch &&
            !customTitleMatch &&
            !projectNameMatch &&
            !initialPromptMatch
          ) {
            continue;
          }
        }

        allSessions.push({
          id: overlaidSession.id,
          title: overlaidSession.title,
          fullTitle: overlaidSession.fullTitle,
          createdAt: overlaidSession.createdAt,
          updatedAt: effectiveUpdatedAt,
          messageCount: overlaidSession.messageCount,
          provider: overlaidSession.provider,
          model: overlaidSession.model,
          projectId: effectiveProjectId,
          projectName: effectiveProject.name,
          ownership,
          pendingInputType,
          activity,
          hasUnread,
          customTitle,
          isArchived,
          isStarred,
          autoResumeDisabled: metadata?.autoResumeDisabled === true,
          parentSessionId,
          parentSessionKind,
          forkedFromSessionId,
          workstreamId: metadata?.workstreamId,
          initialPrompt: initialPrompt ?? undefined,
          executor,
          lastAgentText: overlaidSession.lastAgentText,
        });
      }
    }

    // Sort by updatedAt descending (most recent first)
    allSessions.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );

    // Apply cursor pagination
    let filteredSessions = allSessions;
    if (afterCursor) {
      const afterTime = new Date(afterCursor).getTime();
      filteredSessions = allSessions.filter(
        (s) => new Date(s.updatedAt).getTime() < afterTime,
      );
    }

    // Get one extra to determine hasMore
    const sessionsWithExtra = filteredSessions.slice(0, limit + 1);
    const hasMore = sessionsWithExtra.length > limit;
    const sessions = sessionsWithExtra.slice(0, limit);
    const stats =
      includeStats && !filterProjectId
        ? await getCachedGlobalStats()
        : createEmptyStats();

    const response: GlobalSessionsResponse = {
      sessions,
      hasMore,
      stats,
      projects: projectOptions,
      generation,
    };

    return response;
  }

  return routes;
}
