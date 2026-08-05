/**
 * Inbox route - aggregates sessions across all projects into prioritized tiers.
 *
 * Tiers (in priority order):
 * 1. needsAttention - Sessions with pendingInputType set (tool-approval or user-question)
 * 2. active - In-turn sessions, idle sessions still retaining provider
 *    background work, or existing sessions targeted by pending Project Queue
 *    work, without pending input
 * 3. recentActivity - Sessions updated in the last 30 minutes (not in tiers 1-2)
 * 4. unread8h - Sessions with hasUnread and updatedAt within 8 hours (not in tiers 1-3)
 * 5. unread24h - Sessions with hasUnread and updatedAt within 24 hours (not in tiers 1-4)
 */

import { getSessionDisplayTitle } from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { SessionIndexService } from "../indexes/index.js";
import { SourceVersionedSingleFlight } from "../lib/sourceVersionedSingleFlight.js";
import { getLogger } from "../logging/logger.js";
import type { SessionMetadataService } from "../metadata/SessionMetadataService.js";
import type { NotificationService } from "../notifications/index.js";
import type { CodexSessionScanner } from "../projects/codex-scanner.js";
import type { GeminiSessionScanner } from "../projects/gemini-scanner.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { CodexSessionReader } from "../sessions/codex-reader.js";
import type { GeminiSessionReader } from "../sessions/gemini-reader.js";
import { listSessionListSummariesAcrossProviders } from "../sessions/provider-resolution.js";
import { SessionCollectionGeneration } from "../sessions/sessionCollectionGeneration.js";
import type { GrokSessionReader } from "../sessions/grok-reader.js";
import type { PiSessionReader } from "../sessions/pi-reader.js";
import type { ISessionReader, SessionListSummary } from "../sessions/types.js";
import type { ProjectQueueService } from "../services/ProjectQueueService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type {
  AgentActivity,
  PendingInputType,
  Project,
} from "../supervisor/types.js";
import type { EventBus } from "../watcher/index.js";
import { buildProviderProjectCatalog } from "./provider-catalog.js";
import { getActiveSessionIndexOptions } from "./session-list-options.js";

export interface InboxDeps {
  scanner: ProjectScanner;
  readerFactory: (project: Project) => ISessionReader;
  supervisor?: Supervisor;
  notificationService?: NotificationService;
  sessionIndexService?: SessionIndexService;
  sessionMetadataService?: SessionMetadataService;
  projectQueueService?: Pick<ProjectQueueService, "listAll">;
  codexScanner?: CodexSessionScanner;
  codexSessionsDir?: string;
  codexReaderFactory?: (projectPath: string) => CodexSessionReader;
  geminiScanner?: GeminiSessionScanner;
  geminiSessionsDir?: string;
  geminiReaderFactory?: (projectPath: string) => GeminiSessionReader;
  grokSessionsDir?: string;
  grokReaderFactory?: (projectPath: string) => GrokSessionReader;
  piSessionsDir?: string;
  piReaderFactory?: (projectPath: string) => PiSessionReader;
  eventBus?: EventBus;
  sessionAutoArchiveDays?: number;
}

export interface InboxItem {
  sessionId: string;
  projectId: string;
  projectName: string;
  sessionTitle: string;
  updatedAt: string;
  customTitle?: string;
  isStarred?: boolean;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
}

export interface InboxResponse {
  needsAttention: InboxItem[];
  active: InboxItem[];
  recentActivity: InboxItem[];
  unread8h: InboxItem[];
  unread24h: InboxItem[];
}

/** Maximum items per tier to keep response size manageable */
const MAX_ITEMS_PER_TIER = 20;

/**
 * How much enriched inbox state to retain across requests. Rows are compact
 * summaries, not transcripts; this bounds an unusually large install rather
 * than sizing an expected one.
 */
const INBOX_RETENTION_BYTES = 8 * 1024 * 1024;

/** One session, walked and enriched, before any tier decision is made. */
interface EnrichedInboxSession {
  session: SessionListSummary;
  projectName: string;
  pendingInputType?: PendingInputType;
  activity?: AgentActivity;
  hasUnread?: boolean;
  customTitle?: string;
  isStarred?: boolean;
}

/** Time thresholds in milliseconds */
const THIRTY_MINUTES_MS = 30 * 60 * 1000;
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function getActiveProjectQueueSessionIds(
  projectQueueService: InboxDeps["projectQueueService"],
): Set<string> {
  const sessionIds = new Set<string>();
  if (!projectQueueService) return sessionIds;

  for (const item of projectQueueService.listAll()) {
    if (
      item.target.type === "existing-session" &&
      (item.status === "queued" || item.status === "dispatching")
    ) {
      sessionIds.add(item.target.sessionId);
    }
  }

  return sessionIds;
}

export function createInboxRoutes(deps: InboxDeps): Hono {
  const routes = new Hono();

  const collectionGeneration = new SessionCollectionGeneration(deps.eventBus);
  /**
   * One walk per (project filter, generation), however many tabs ask for it.
   *
   * The Inbox is mounted by the app shell, so a herd of tabs reconnecting used
   * to run a herd of independent walks over every project — the same defect
   * `GET /api/sessions` had. The generation is the collection's, so the same
   * deny-list over bus events decides when a retained walk stops being usable.
   *
   * `isCurrent` is vacuous for the reason it is on the global session walk: the
   * generation is read before the walk, so a change landing mid-walk leaves the
   * retained entry unreachable rather than wrong.
   */
  const inboxWalks = new SourceVersionedSingleFlight<
    string,
    EnrichedInboxSession[]
  >({
    maxRetainedBytes: INBOX_RETENTION_BYTES,
    estimateBytes: (value) => value.length * 512,
  });

  async function walkInbox(
    filterProjectId: string | undefined,
  ): Promise<EnrichedInboxSession[]> {
    const allProjects = await deps.scanner.listProjects();

    // Filter to single project if projectId query param provided
    const projects = filterProjectId
      ? allProjects.filter((p) => p.id === filterProjectId)
      : allProjects;

    const allSessions: EnrichedInboxSession[] = [];

    const logger = getLogger();
    const providerCatalog = await buildProviderProjectCatalog({
      codexScanner: deps.codexScanner,
      geminiScanner: deps.geminiScanner,
    });
    const listOptions = getActiveSessionIndexOptions(
      deps.sessionAutoArchiveDays,
    );

    // Fetch sessions from all projects in parallel
    const projectSessionResults = await Promise.all(
      projects.map(async (project) => {
        try {
          const sessions = await listSessionListSummariesAcrossProviders(
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
            listOptions,
          );
          return { project, sessions };
        } catch (err) {
          logger.warn(
            { err, projectId: project.id },
            "Failed to fetch sessions for inbox project",
          );
          return { project, sessions: [] as SessionListSummary[] };
        }
      }),
    );

    // Enrich each session with process state and notification data
    for (const { project, sessions } of projectSessionResults) {
      for (const session of sessions) {
        const metadata = deps.sessionMetadataService?.getMetadata(session.id);
        const isArchived = metadata?.isArchived ?? session.isArchived ?? false;
        if (isArchived) continue;

        let pendingInputType: PendingInputType | undefined;
        let activity: AgentActivity | undefined;

        const process = deps.supervisor?.getProcessForSession(session.id);
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
            // Idle but the provider still has background tasks/crons running.
            // Surface as active so the session lands in the "Active" tier
            // instead of "Recent Activity", matching the session page.
            activity = "in-turn";
          }
        }

        const hasUnread = deps.notificationService
          ? deps.notificationService.hasUnread(session.id, session.updatedAt)
          : undefined;

        allSessions.push({
          session,
          projectName: project.name,
          pendingInputType,
          activity,
          hasUnread,
          customTitle: metadata?.customTitle ?? session.customTitle,
          isStarred: metadata?.isStarred ?? session.isStarred ?? false,
        });
      }
    }

    return allSessions;
  }

  async function readInbox(
    filterProjectId: string | undefined,
  ): Promise<EnrichedInboxSession[]> {
    const result = await inboxWalks.run({
      key: filterProjectId ?? "",
      sourceVersion: String(collectionGeneration.current),
      compute: () => walkInbox(filterProjectId),
      isCurrent: () => true,
    });
    if (result.status === "stale") {
      // Unreachable while `isCurrent` is vacuous; walking again is the only
      // answer that cannot be wrong if that ever changes.
      return walkInbox(filterProjectId);
    }
    return result.value;
  }

  // GET /api/inbox - Get prioritized inbox of sessions
  // Optional query param: projectId - filter to a single project
  routes.get("/", async (c) => {
    const now = Date.now();
    const filterProjectId = c.req.query("projectId");

    // Only the walk is retained. Tier membership is a wall-clock decision —
    // 30 minutes, 8 hours, 24 hours — so retaining a tiered response would
    // freeze those windows at the instant of the walk, and a session would
    // stay in "Recent Activity" for as long as nothing on the bus moved.
    const allSessions = await readInbox(filterProjectId);
    const activeProjectQueueSessionIds = getActiveProjectQueueSessionIds(
      deps.projectQueueService,
    );

    // Build the inbox response by categorizing into tiers
    const needsAttention: InboxItem[] = [];
    const active: InboxItem[] = [];
    const recentActivity: InboxItem[] = [];
    const unread8h: InboxItem[] = [];
    const unread24h: InboxItem[] = [];

    // Track which sessions have been assigned to a tier
    const assignedSessionIds = new Set<string>();

    // Helper to convert to InboxItem
    const toInboxItem = (item: EnrichedInboxSession): InboxItem => ({
      sessionId: item.session.id,
      projectId: item.session.projectId,
      projectName: item.projectName,
      sessionTitle: getSessionDisplayTitle({
        customTitle: item.customTitle,
        title: item.session.title,
      }),
      updatedAt: item.session.updatedAt,
      customTitle: item.customTitle,
      isStarred: item.isStarred,
      pendingInputType: item.pendingInputType,
      activity: item.activity,
      hasUnread: item.hasUnread,
    });

    // Tier 1: needsAttention - sessions with pending input
    for (const item of allSessions) {
      if (item.pendingInputType) {
        needsAttention.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 2: active - live sessions and sessions with pending Project Queue work
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (
        item.activity === "in-turn" ||
        activeProjectQueueSessionIds.has(item.session.id)
      ) {
        active.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 3: recentActivity - updated in last 30 minutes
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      const updatedAt = new Date(item.session.updatedAt).getTime();
      if (now - updatedAt <= THIRTY_MINUTES_MS) {
        recentActivity.push(toInboxItem(item));
        assignedSessionIds.add(item.session.id);
      }
    }

    // Tier 4: unread8h - unread and updated within 8 hours
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (item.hasUnread) {
        const updatedAt = new Date(item.session.updatedAt).getTime();
        if (now - updatedAt <= EIGHT_HOURS_MS) {
          unread8h.push(toInboxItem(item));
          assignedSessionIds.add(item.session.id);
        }
      }
    }

    // Tier 5: unread24h - unread and updated within 24 hours
    for (const item of allSessions) {
      if (assignedSessionIds.has(item.session.id)) continue;
      if (item.hasUnread) {
        const updatedAt = new Date(item.session.updatedAt).getTime();
        if (now - updatedAt <= TWENTY_FOUR_HOURS_MS) {
          unread24h.push(toInboxItem(item));
          assignedSessionIds.add(item.session.id);
        }
      }
    }

    // Sort each tier by updatedAt descending (most recent first)
    const sortByUpdatedAt = (a: InboxItem, b: InboxItem) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();

    needsAttention.sort(sortByUpdatedAt);
    active.sort(sortByUpdatedAt);
    recentActivity.sort(sortByUpdatedAt);
    unread8h.sort(sortByUpdatedAt);
    unread24h.sort(sortByUpdatedAt);

    // Apply limits per tier
    const response: InboxResponse = {
      needsAttention: needsAttention.slice(0, MAX_ITEMS_PER_TIER),
      active: active.slice(0, MAX_ITEMS_PER_TIER),
      recentActivity: recentActivity.slice(0, MAX_ITEMS_PER_TIER),
      unread8h: unread8h.slice(0, MAX_ITEMS_PER_TIER),
      unread24h: unread24h.slice(0, MAX_ITEMS_PER_TIER),
    };

    return c.json(response);
  });

  return routes;
}
