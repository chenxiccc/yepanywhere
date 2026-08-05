import {
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_DOWNLOAD_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  type ProjectQueueItemSummary,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import type { GlobalSessionItem } from "../api/client";
import { useOptionalRemoteConnection } from "../contexts/RemoteConnectionContext";
import { useNewSessionDraft } from "../hooks/useDrafts";
import { useProjectQueues } from "../hooks/useProjectQueues";
import { useProjects } from "../hooks/useProjects";
import { useProcesses } from "../hooks/useProcesses";
import {
  getProjectIdFromLocation,
  resolvePreferredProjectId,
} from "../hooks/useRecentProject";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { useSidebarDuplicateHiding } from "../hooks/useSidebarDuplicateHiding";
import { useSidebarSessionFeeds } from "../hooks/useSidebarSessionFeeds";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH } from "../hooks/useSidebarWidth";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import { bangHistoryViewEnabled } from "../lib/bangCommandAvailability";
import { buildFrontendReloadUrl } from "../lib/frontendReload";
import { isNearScrollEnd } from "../lib/predictiveScroll";
import { serverSupportsProjectQueue } from "../lib/projectQueueVisibility";
import { sessionCollectionRecordToGlobalSessionItem } from "../lib/sessionCollectionRecords";
import type { SessionCollectionRecord } from "../lib/clientSummaryCollections";
import {
  selectOlderSessionRecordsFromRecords,
  selectRecentSessionRecordsFromRecords,
} from "../lib/clientSummaryQueries";
import {
  useDraftSessionIds,
  useInboxCounts,
  useKnownProjectQueueItems,
  useProjectQueuedSessionIds,
  useProjectQueueSidebarCount,
  useSessionCollectionQueryRecords,
  useStarredSessionRecords,
} from "../lib/clientSummaryStore";
import { UI_KEYS } from "../lib/storageKeys";
import { getSessionDisplayTitle } from "../utils";
import { AgentsNavItem } from "./AgentsNavItem";
import { SessionListItem } from "./SessionListItem";
import {
  SidebarIcons,
  SidebarNavButton,
  SidebarNavItem,
  SidebarNavSection,
} from "./SidebarNavItem";
import { YepAnywhereLogo } from "./YepAnywhereLogo";

const SWIPE_THRESHOLD = 50; // Minimum distance to trigger close
const SWIPE_ENGAGE_THRESHOLD = 15; // Minimum horizontal distance before swipe engages

export function SidebarToggleIcon() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="9" y1="3" x2="9" y2="21" />
    </svg>
  );
}

const DEFAULT_SECTION_EXPANSION = {
  projectQueue: true,
  starred: true,
  recentDay: true,
  older: true,
};

type SidebarPendingProjectQueueItem = ProjectQueueItemSummary & {
  target: Extract<ProjectQueueItemSummary["target"], { type: "new-session" }>;
};

type SidebarSessionItem = GlobalSessionItem & {
  activityInferredFromInboxTier?: boolean;
};

const EMPTY_PROJECT_QUEUE_PROJECT_IDS: readonly string[] = [];
const EMPTY_PROJECT_QUEUE_PROJECTS: readonly {
  id: string;
  projectQueueCount?: number;
  snapshotObservedAt?: number;
}[] = [];
const EMPTY_PROJECT_QUEUE_SESSION_IDS: ReadonlySet<string> = new Set();

/**
 * A session is "active" while its agent is mid-turn or waiting on input. Active
 * sessions are pinned above idle rows and are deliberately sorted by the time
 * they became active rather than by updatedAt. Their updatedAt churns every few
 * seconds during a turn, so recency ordering would reshuffle them constantly.
 */
function isActiveSession(session: GlobalSessionItem): boolean {
  return session.activity === "in-turn" || session.activity === "waiting-input";
}

function sessionCollectionRecordsToSidebarSessionItems(
  records: readonly SessionCollectionRecord[],
): SidebarSessionItem[] {
  const sessions: SidebarSessionItem[] = [];
  for (const record of records) {
    const session = sessionCollectionRecordToGlobalSessionItem(record);
    if (!session) continue;
    sessions.push({
      ...session,
      activityInferredFromInboxTier: record.activityInferredFromInboxTier,
    });
  }
  return sessions;
}

function getSidebarRowActivity(
  session: SidebarSessionItem,
): GlobalSessionItem["activity"] {
  if (session.activityInferredFromInboxTier) {
    return undefined;
  }
  return session.activity;
}

function duplicateGroupingTitle(session: GlobalSessionItem): string {
  return (
    session.customTitle ??
    session.fullTitle ??
    session.title ??
    session.initialPrompt ??
    ""
  );
}

function duplicateGroupingKey(session: GlobalSessionItem): string | null {
  const title = duplicateGroupingTitle(session).trim();
  if (!title) return null;
  const normalizedTitle = title.replace(/\s+/g, " ").toLowerCase();
  return `${session.provider || "unknown"}|${session.projectId}|${normalizedTitle}`;
}

function updatedAtMs(session: GlobalSessionItem): number {
  return new Date(session.updatedAt).getTime();
}

function duplicateRepresentativeRank(session: GlobalSessionItem): number {
  if (session.isArchived) return 0;
  if (session.isStarred) return 3;
  if (session.ownership?.owner === "external") return 2;
  return 1;
}

function compareDuplicateRepresentative(
  a: GlobalSessionItem,
  b: GlobalSessionItem,
): number {
  const rankDiff =
    duplicateRepresentativeRank(b) - duplicateRepresentativeRank(a);
  if (rankDiff !== 0) return rankDiff;
  const messageCountDiff = (b.messageCount || 0) - (a.messageCount || 0);
  if (messageCountDiff !== 0) return messageCountDiff;
  return updatedAtMs(b) - updatedAtMs(a);
}

// Named with a `debugLog` prefix so the console-chatter scanner treats its
// console.debug sites as dev-gated (topics/console-chatter.md); the call site
// still guards on import.meta.env.DEV so nothing runs in production.
function debugLogSidebarDuplicates(sessions: SidebarSessionItem[]): void {
  const idCounts = new Map<string, number>();
  for (const session of sessions) {
    idCounts.set(session.id, (idCounts.get(session.id) ?? 0) + 1);
  }
  const repeatedIds = [...idCounts].filter(([, count]) => count > 1);
  if (repeatedIds.length > 0) {
    console.debug("[Sidebar] repeated session ids in recent list", repeatedIds);
  }
  const groups = new Map<string, SidebarSessionItem[]>();
  for (const session of sessions) {
    const key = duplicateGroupingKey(session);
    if (!key) continue;
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(session);
  }
  for (const [key, arr] of groups) {
    if (arr.length <= 1) continue;
    console.debug(
      `[Sidebar] duplicate-title group (${arr.length}) ${key}`,
      arr.map((session) => ({
        id: session.id,
        activity: session.activity,
        updatedAt: session.updatedAt,
        owner: session.ownership?.owner,
        messageCount: session.messageCount,
      })),
    );
  }
}

function isSidebarPendingProjectQueueItem(
  item: ProjectQueueItemSummary,
): item is SidebarPendingProjectQueueItem {
  return (
    item.target.type === "new-session" &&
    (item.status === "queued" || item.status === "failed")
  );
}

type SidebarSectionKey = keyof typeof DEFAULT_SECTION_EXPANSION;
type SidebarSectionExpansion = Record<SidebarSectionKey, boolean>;

function getLocalStorage(): Storage | null {
  return typeof window !== "undefined" && window.localStorage
    ? window.localStorage
    : null;
}

function loadSidebarSectionExpansion(): SidebarSectionExpansion {
  const storage = getLocalStorage();
  if (!storage) {
    return DEFAULT_SECTION_EXPANSION;
  }

  try {
    const raw = storage.getItem(UI_KEYS.sidebarSectionExpansion);
    if (!raw) {
      return DEFAULT_SECTION_EXPANSION;
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return DEFAULT_SECTION_EXPANSION;
    }
    const value = parsed as Partial<Record<SidebarSectionKey, unknown>>;
    return {
      projectQueue:
        typeof value.projectQueue === "boolean"
          ? value.projectQueue
          : DEFAULT_SECTION_EXPANSION.projectQueue,
      starred:
        typeof value.starred === "boolean"
          ? value.starred
          : DEFAULT_SECTION_EXPANSION.starred,
      recentDay:
        typeof value.recentDay === "boolean"
          ? value.recentDay
          : DEFAULT_SECTION_EXPANSION.recentDay,
      older:
        typeof value.older === "boolean"
          ? value.older
          : DEFAULT_SECTION_EXPANSION.older,
    };
  } catch {
    return DEFAULT_SECTION_EXPANSION;
  }
}

function saveSidebarSectionExpansion(expansion: SidebarSectionExpansion): void {
  const storage = getLocalStorage();
  if (!storage) {
    return;
  }

  try {
    storage.setItem(UI_KEYS.sidebarSectionExpansion, JSON.stringify(expansion));
  } catch {
    // localStorage is a UI convenience; in-memory state still applies.
  }
}

interface SidebarSectionHeaderProps {
  title: string;
  expanded: boolean;
  onToggle: () => void;
  controlsId: string;
  expandLabel: string;
  collapseLabel: string;
}

function SidebarSectionHeader({
  title,
  expanded,
  onToggle,
  controlsId,
  expandLabel,
  collapseLabel,
}: SidebarSectionHeaderProps) {
  const actionLabel = expanded ? collapseLabel : expandLabel;

  return (
    <div className="sidebar-section-header">
      <h3 className="sidebar-section-title">{title}</h3>
      <button
        type="button"
        className="sidebar-section-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
        aria-controls={controlsId}
        aria-label={`${actionLabel}: ${title}`}
        title={`${actionLabel}: ${title}`}
      >
        {expanded ? "-" : "+"}
      </button>
    </div>
  );
}

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  onNavigate: () => void;

  /** Current session ID (for highlighting in sidebar) */
  currentSessionId?: string;

  /** Desktop mode: sidebar is always visible, no overlay */
  isDesktop?: boolean;
  /** Desktop mode: sidebar is collapsed (icons only) */
  isCollapsed?: boolean;
  /** Desktop mode: callback to toggle expanded/collapsed state */
  onToggleExpanded?: () => void;
  /** Desktop collapsed mode: remove the rail and leave a floating restore toggle */
  onMinimize?: () => void;
  /** Desktop mode: current sidebar width in pixels */
  sidebarWidth?: number;
  /** Desktop mode: called when resize starts */
  onResizeStart?: () => void;
  /** Desktop mode: called during resize with new width */
  onResize?: (width: number) => void;
  /** Desktop mode: called when resize ends */
  onResizeEnd?: () => void;
}

export function Sidebar({
  isOpen,
  onClose,
  onNavigate,
  currentSessionId,
  // Desktop mode props
  isDesktop = false,
  isCollapsed = false,
  onToggleExpanded,
  onMinimize,
  sidebarWidth,
  onResizeStart,
  onResize,
  onResizeEnd,
}: SidebarProps) {
  const { t } = useI18n();
  // Get base path for relay mode (e.g., "/remote/my-server")
  const basePath = useRemoteBasePath();
  const { sidebarDuplicateHidingEnabled } = useSidebarDuplicateHiding();
  const navigate = useNavigate();
  const location = useLocation();
  const remoteConnection = useOptionalRemoteConnection();
  const { settings: serverSettings } = useServerSettings();
  const publicSharesEnabled = serverSettings?.publicSharesEnabled ?? false;
  const { status: publicShareStatus } = usePublicShareStatus({
    poll: publicSharesEnabled,
  });
  const publicShareControlsVisible = publicShareStatus?.canCreate ?? false;
  const { processes, terminatedProcesses } = useProcesses();
  const providerChildrenBySessionId = useMemo(
    () =>
      new Map(
        [...processes, ...terminatedProcesses]
          .filter((process) => process.providerChildren?.length)
          .map((process) => [process.sessionId, process.providerChildren]),
      ),
    [processes, terminatedProcesses],
  );

  const {
    globalQuery,
    loading: sessionsLoading,
    hasMoreGlobalSessions,
    loadMoreGlobalSessions,
    hasMoreStarredSessions,
    loadMoreStarredSessions,
  } = useSidebarSessionFeeds();

  const globalQueryRecords = useSessionCollectionQueryRecords(globalQuery);
  const starredSessionRecords = useStarredSessionRecords();
  const recentSessionRecords = useMemo(
    () => selectRecentSessionRecordsFromRecords(globalQueryRecords),
    [globalQueryRecords],
  );
  const olderSessionRecords = useMemo(
    () => selectOlderSessionRecordsFromRecords(globalQueryRecords),
    [globalQueryRecords],
  );

  const hasNewSessionDraft = useNewSessionDraft();

  // Server capabilities for feature gating
  const { version: versionInfo } = useVersion();
  const bangHistoryVisible = bangHistoryViewEnabled(
    versionInfo,
    serverSettings?.clientDefaults,
  );
  const supportsProjectQueue = serverSupportsProjectQueue(versionInfo);
  const supportsSourceControl = serverHasCapability(
    versionInfo,
    GIT_STATUS_ENHANCED_CAPABILITY,
  );
  const supportsDeviceBridgeNav =
    serverHasCapability(versionInfo, DEVICE_BRIDGE_CAPABILITY) ||
    serverHasCapability(versionInfo, DEVICE_BRIDGE_DOWNLOAD_CAPABILITY);

  // Global inbox count. Title badge updates are owned by the app shell.
  const { needsAttention: inboxCount } = useInboxCounts();
  const { projects } = useProjects();
  const sourceControlProjectId = useMemo(
    () =>
      getProjectIdFromLocation(location.pathname, location.search) ??
      resolvePreferredProjectId(projects),
    [location.pathname, location.search, projects],
  );
  const sourceControlPath = sourceControlProjectId
    ? `/git-status?projectId=${encodeURIComponent(sourceControlProjectId)}`
    : "/git-status";
  const projectQueueSidebarCount = useProjectQueueSidebarCount(
    supportsProjectQueue ? projects : EMPTY_PROJECT_QUEUE_PROJECTS,
  );
  const newSessionPath = "/new-session";
  const newSessionHref = `${basePath}${newSessionPath}`;
  const expandedSidebarNewSessionHref = toBrowserAppHref(
    `${newSessionHref}${newSessionHref.includes("?") ? "&" : "?"}sidebar=expanded`,
  );

  const sidebarRef = useRef<HTMLElement>(null);
  const sidebarSessionsRef = useRef<HTMLDivElement | null>(null);
  const touchStartX = useRef<number | null>(null);
  const touchStartY = useRef<number | null>(null);
  const swipeEngaged = useRef<boolean>(false);
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [isResizing, setIsResizing] = useState(false);
  const resizeStartX = useRef<number | null>(null);
  const resizeStartWidth = useRef<number | null>(null);
  const [sectionExpansion, setSectionExpansion] = useState(
    loadSidebarSectionExpansion,
  );
  const projectQueueExpanded = sectionExpansion.projectQueue;
  const starredExpanded = sectionExpansion.starred;
  const recentDayExpanded = sectionExpansion.recentDay;
  const olderExpanded = sectionExpansion.older;
  const loadingMoreGlobalSessionsRef = useRef(false);
  const loadingMoreStarredSessionsRef = useRef(false);

  const setSidebarSectionExpanded = useCallback(
    (
      section: SidebarSectionKey,
      update: boolean | ((current: boolean) => boolean),
    ) => {
      setSectionExpansion((current) => {
        const nextValue =
          typeof update === "function" ? update(current[section]) : update;
        const next = { ...current, [section]: nextValue };
        saveSidebarSectionExpansion(next);
        return next;
      });
    },
    [],
  );

  const maybeLoadMoreGlobalSessions = useCallback(async () => {
    if (!hasMoreGlobalSessions || loadingMoreGlobalSessionsRef.current) {
      return;
    }
    loadingMoreGlobalSessionsRef.current = true;
    try {
      await loadMoreGlobalSessions();
    } finally {
      loadingMoreGlobalSessionsRef.current = false;
    }
  }, [hasMoreGlobalSessions, loadMoreGlobalSessions]);

  const maybeLoadMoreStarredSessions = useCallback(async () => {
    if (!hasMoreStarredSessions || loadingMoreStarredSessionsRef.current) {
      return;
    }
    loadingMoreStarredSessionsRef.current = true;
    try {
      await loadMoreStarredSessions();
    } finally {
      loadingMoreStarredSessionsRef.current = false;
    }
  }, [hasMoreStarredSessions, loadMoreStarredSessions]);

  const maybeLoadMoreSidebarSessions = useCallback(() => {
    const element = sidebarSessionsRef.current;
    if (!element || !isNearScrollEnd(element)) {
      return;
    }
    void maybeLoadMoreGlobalSessions();
    void maybeLoadMoreStarredSessions();
  }, [maybeLoadMoreGlobalSessions, maybeLoadMoreStarredSessions]);
  const sidebarLoadMoreKey = [
    starredSessionRecords.length,
    recentSessionRecords.length,
    olderSessionRecords.length,
    projectQueueExpanded,
    starredExpanded,
    recentDayExpanded,
    olderExpanded,
  ].join("\0");

  useEffect(() => {
    void sidebarLoadMoreKey;
    maybeLoadMoreSidebarSessions();
  }, [maybeLoadMoreSidebarSessions, sidebarLoadMoreKey]);

  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartX.current = e.touches[0]?.clientX ?? null;
    touchStartY.current = e.touches[0]?.clientY ?? null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStartX.current === null || touchStartY.current === null) return;
    const currentX = e.touches[0]?.clientX;
    const currentY = e.touches[0]?.clientY;
    if (currentX === undefined || currentY === undefined) return;

    const diffX = currentX - touchStartX.current;
    const diffY = currentY - touchStartY.current;

    // If not yet engaged, check if we should engage the swipe
    if (!swipeEngaged.current) {
      const absDiffX = Math.abs(diffX);
      const absDiffY = Math.abs(diffY);

      // Engage swipe only if:
      // 1. Horizontal movement exceeds threshold
      // 2. Horizontal movement is greater than vertical (user is swiping, not scrolling)
      // 3. Movement is to the left (closing gesture)
      if (
        absDiffX > SWIPE_ENGAGE_THRESHOLD &&
        absDiffX > absDiffY &&
        diffX < 0
      ) {
        swipeEngaged.current = true;
      } else {
        return; // Not engaged yet, don't track offset
      }
    }

    // Only allow swiping left (negative offset)
    if (diffX < 0) {
      setSwipeOffset(diffX);
    }
  };

  const handleTouchEnd = () => {
    if (swipeEngaged.current && swipeOffset < -SWIPE_THRESHOLD) {
      onClose();
    }
    touchStartX.current = null;
    touchStartY.current = null;
    swipeEngaged.current = false;
    setSwipeOffset(0);
  };

  // Desktop sidebar resize handlers
  const handleResizeMouseDown = (e: React.MouseEvent) => {
    if (!isDesktop || isCollapsed || !sidebarWidth) return;
    e.preventDefault();
    resizeStartX.current = e.clientX;
    resizeStartWidth.current = sidebarWidth;
    setIsResizing(true);
    onResizeStart?.();
  };

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (resizeStartX.current === null || resizeStartWidth.current === null)
        return;
      const diff = e.clientX - resizeStartX.current;
      const newWidth = resizeStartWidth.current + diff;
      onResize?.(newWidth);
    };

    const handleMouseUp = () => {
      resizeStartX.current = null;
      resizeStartWidth.current = null;
      setIsResizing(false);
      onResizeEnd?.();
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing, onResize, onResizeEnd]);

  // Handle switching hosts - disconnect and go to host picker
  const handleSwitchHost = () => {
    remoteConnection?.disconnect();
    const loginUrl = new URL("/login", window.location.href);
    window.location.replace(
      buildFrontendReloadUrl(loginUrl, String(Date.now())),
    );
  };

  const handleCollapsedToggleClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.button === 1 || e.metaKey || e.ctrlKey || e.shiftKey) {
        e.preventDefault();
        e.stopPropagation();
        window.open(expandedSidebarNewSessionHref, "_blank", "noopener");
        return;
      }

      onToggleExpanded?.();
    },
    [expandedSidebarNewSessionHref, onToggleExpanded],
  );

  const handleCollapsedToggleMouseDown = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.button === 1) {
        e.preventDefault();
      }
    },
    [],
  );

  const handleCollapsedToggleAuxClick = useCallback(
    (e: React.MouseEvent<HTMLButtonElement>) => {
      if (e.button !== 1) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(expandedSidebarNewSessionHref, "_blank", "noopener");
    },
    [expandedSidebarNewSessionHref],
  );

  const filteredStarredSessions = useMemo(
    () => sessionCollectionRecordsToSidebarSessionItems(starredSessionRecords),
    [starredSessionRecords],
  );

  const recentDaySessions = useMemo(
    () => sessionCollectionRecordsToSidebarSessionItems(recentSessionRecords),
    [recentSessionRecords],
  );

  const olderSessions = useMemo(
    () => sessionCollectionRecordsToSidebarSessionItems(olderSessionRecords),
    [olderSessionRecords],
  );

  const sidebarProjectIds = useMemo(
    () => [
      ...new Set(
        [...filteredStarredSessions, ...recentDaySessions, ...olderSessions]
          .map((session) => session.projectId)
          .filter(Boolean),
      ),
    ],
    [filteredStarredSessions, recentDaySessions, olderSessions],
  );
  const projectQueueProjectIds = useMemo(
    () =>
      projects
        .filter((project) => (project.projectQueueCount ?? 0) > 0)
        .map((project) => project.id),
    [projects],
  );
  const sidebarQueueProjectIds = useMemo(
    () => [...new Set([...sidebarProjectIds, ...projectQueueProjectIds])],
    [projectQueueProjectIds, sidebarProjectIds],
  );
  const supportedSidebarQueueProjectIds = supportsProjectQueue
    ? sidebarQueueProjectIds
    : EMPTY_PROJECT_QUEUE_PROJECT_IDS;
  const supportedSidebarProjectIds = supportsProjectQueue
    ? sidebarProjectIds
    : EMPTY_PROJECT_QUEUE_PROJECT_IDS;
  // Keep the queue feed mounted for visible session rows and projects that
  // report queue work. Badge rendering itself uses the shared count selector.
  const projectQueues = useProjectQueues(supportedSidebarQueueProjectIds);
  const rawProjectQueuedSessionIds = useProjectQueuedSessionIds(
    supportedSidebarProjectIds,
  );
  const projectQueuedSessionIds = supportsProjectQueue
    ? rawProjectQueuedSessionIds
    : EMPTY_PROJECT_QUEUE_SESSION_IDS;
  const knownProjectQueueItems = useKnownProjectQueueItems();
  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const pendingProjectQueueItems = useMemo(
    () =>
      supportsProjectQueue
        ? knownProjectQueueItems.filter(isSidebarPendingProjectQueueItem)
        : [],
    [knownProjectQueueItems, supportsProjectQueue],
  );
  const handlePendingProjectQueueClick = useCallback(
    async (
      event: React.MouseEvent<HTMLAnchorElement>,
      item: SidebarPendingProjectQueueItem,
    ) => {
      const targetPath = `${basePath}/projects?queueItem=${encodeURIComponent(
        item.id,
      )}`;
      const isPlainLeftClick =
        event.button === 0 &&
        !event.metaKey &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey;
      if (!isPlainLeftClick || item.status !== "queued") {
        onNavigate();
        return;
      }

      event.preventDefault();
      try {
        const result = await projectQueues.promoteNow(item.projectId, item.id);
        if (result.promoted && result.sessionId) {
          navigate(
            `${basePath}/projects/${encodeURIComponent(
              item.projectId,
            )}/sessions/${encodeURIComponent(result.sessionId)}`,
          );
        } else {
          navigate(targetPath);
        }
      } catch {
        navigate(targetPath);
      }
      onNavigate();
    },
    [basePath, navigate, onNavigate, projectQueues.promoteNow],
  );

  // Client-side duplicate-title hiding is deliberately fail-open. It only
  // hides unrelated exact-title idle rows when a user-facing representative is
  // also visible in this section.
  const [showHiddenRecent, setShowHiddenRecent] = useState(false);
  const [showHiddenOlder, setShowHiddenOlder] = useState(false);

  const groupDuplicateSessions = useCallback(
    (sessions: SidebarSessionItem[]) => {
      const groups = new Map<string, SidebarSessionItem[]>();
      for (const s of sessions) {
        const key = duplicateGroupingKey(s);
        if (!key) continue;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)?.push(s);
      }

      const visibleIds = new Set<string>();
      const hidden: GlobalSessionItem[] = [];
      for (const s of sessions) {
        const key = duplicateGroupingKey(s);
        const group = key ? groups.get(key) : undefined;
        if (!group || group.length === 1) {
          visibleIds.add(s.id);
        }
      }

      for (const arr of groups.values()) {
        if (arr.length <= 1) continue;

        const groupSessionIds = new Set(arr.map((session) => session.id));
        const sourceIdsInGroup = new Set(
          arr.flatMap((session) =>
            [session.parentSessionId, session.forkedFromSessionId].filter(
              (id): id is string =>
                typeof id === "string" && groupSessionIds.has(id),
            ),
          ),
        );
        const protectedRows = arr.filter(
          (session) =>
            session.id === currentSessionId ||
            session.ownership?.owner === "self" ||
            Boolean(session.parentSessionId) ||
            Boolean(session.forkedFromSessionId) ||
            sourceIdsInGroup.has(session.id),
        );
        for (const session of protectedRows) {
          visibleIds.add(session.id);
        }

        const hidable = arr.filter((session) => !visibleIds.has(session.id));
        if (hidable.length <= 1) {
          for (const session of hidable) {
            visibleIds.add(session.id);
          }
          continue;
        }

        const sorted = [...hidable].sort(compareDuplicateRepresentative);
        const selected = sorted[0];
        if (!selected) continue;
        visibleIds.add(selected.id);
        hidden.push(...sorted.slice(1));
      }

      const visible = sessions.filter((session) => visibleIds.has(session.id));
      visible.sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
      hidden.sort((a, b) => updatedAtMs(b) - updatedAtMs(a));
      return { visible, hidden };
    },
    [currentSessionId],
  );

  // Active and queued rows are actionable live state, not title duplicates.
  // Keep every pinned row visible; stale activity must be corrected where the
  // source identity changes rather than hidden by a presentation heuristic.
  const recentPinned = useMemo(
    () =>
      recentDaySessions.filter(
        (session) =>
          isActiveSession(session) || projectQueuedSessionIds.has(session.id),
      ),
    [projectQueuedSessionIds, recentDaySessions],
  );

  const { visibleRecent, hiddenRecent } = useMemo(() => {
    const idle = recentDaySessions.filter(
      (session) =>
        !isActiveSession(session) && !projectQueuedSessionIds.has(session.id),
    );
    if (!sidebarDuplicateHidingEnabled) {
      return { visibleRecent: idle, hiddenRecent: [] };
    }
    const { visible, hidden } = groupDuplicateSessions(idle);
    return { visibleRecent: visible, hiddenRecent: hidden };
  }, [
    groupDuplicateSessions,
    projectQueuedSessionIds,
    recentDaySessions,
    sidebarDuplicateHidingEnabled,
  ]);

  const { visibleOlder, hiddenOlder } = useMemo(() => {
    if (!sidebarDuplicateHidingEnabled) {
      return { visibleOlder: olderSessions, hiddenOlder: [] };
    }
    const { visible, hidden } = groupDuplicateSessions(olderSessions);
    return { visibleOlder: visible, hiddenOlder: hidden };
  }, [groupDuplicateSessions, olderSessions, sidebarDuplicateHidingEnabled]);

  // Dev-only: surface how a single logical conversation fans out across rotated
  // session ids (and flag any true repeated id, which the collapse cannot fix).
  useEffect(() => {
    if (import.meta.env.DEV) debugLogSidebarDuplicates(recentDaySessions);
  }, [recentDaySessions]);

  const drafts = useDraftSessionIds();

  // Single source of truth for a compact sidebar session row, so the six
  // section render sites (starred / recent / older, each with a hidden-dups
  // sublist) stay identical. `createdAt` + `model` + `lastAgentText` feed the
  // hover card.
  const renderCompactSession = (session: SidebarSessionItem) => {
    const hasProjectQueue = projectQueuedSessionIds.has(session.id);
    return (
      <SessionListItem
        key={session.id}
        sessionId={session.id}
        projectId={session.projectId}
        title={getSessionDisplayTitle(session)}
        fullTitle={session.fullTitle ?? getSessionDisplayTitle(session)}
        initialPrompt={session.initialPrompt}
        hasCustomTitle={!!session.customTitle}
        lastAgentText={session.lastAgentText}
        provider={session.provider}
        model={session.model}
        createdAt={session.createdAt}
        updatedAt={session.updatedAt}
        parentSessionId={session.parentSessionId}
        parentSessionKind={session.parentSessionKind}
        providerChildren={providerChildrenBySessionId.get(session.id)}
        status={session.ownership}
        pendingInputType={session.pendingInputType}
        hasUnread={session.hasUnread}
        isStarred={session.isStarred}
        isArchived={session.isArchived}
        mode="compact"
        isCurrent={session.id === currentSessionId}
        activity={getSidebarRowActivity(session)}
        onNavigate={onNavigate}
        showProjectName
        projectName={session.projectName}
        basePath={basePath}
        messageCount={session.messageCount}
        hasDraft={drafts.has(session.id)}
        hasProjectQueue={hasProjectQueue}
        publicShareControlsVisible={publicShareControlsVisible}
      />
    );
  };

  // In desktop mode, always render. In mobile mode, only render when open.
  if (!isDesktop && !isOpen) return null;

  return (
    <>
      {/* Only show overlay in non-desktop mode */}
      {!isDesktop && (
        <div
          className="sidebar-overlay"
          onClick={onClose}
          onKeyDown={(e) => e.key === "Escape" && onClose()}
          role="button"
          tabIndex={0}
          aria-label={t("actionCloseSidebar")}
        />
      )}
      <aside
        ref={sidebarRef}
        className="sidebar"
        onTouchStart={!isDesktop ? handleTouchStart : undefined}
        onTouchMove={!isDesktop ? handleTouchMove : undefined}
        onTouchEnd={!isDesktop ? handleTouchEnd : undefined}
        style={
          !isDesktop && swipeOffset < 0
            ? { transform: `translateX(${swipeOffset}px)`, transition: "none" }
            : undefined
        }
      >
        <div className="sidebar-header">
          {isDesktop && isCollapsed ? (
            /* Desktop collapsed mode: expand from the main icon or minimize the rail. */
            <>
              <button
                type="button"
                className="sidebar-toggle"
                onClick={handleCollapsedToggleClick}
                onMouseDown={handleCollapsedToggleMouseDown}
                onAuxClick={handleCollapsedToggleAuxClick}
                title={t("actionExpandSidebar")}
                aria-label={t("actionExpandSidebar")}
              >
                <SidebarToggleIcon />
              </button>
              {onMinimize && (
                <button
                  type="button"
                  className="sidebar-minimize"
                  onClick={onMinimize}
                  title={t("actionMinimizeSidebar")}
                  aria-label={t("actionMinimizeSidebar")}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 12 12"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    aria-hidden="true"
                  >
                    <line x1="2" y1="10" x2="10" y2="10" />
                  </svg>
                </button>
              )}
            </>
          ) : isDesktop ? (
            /* Desktop expanded mode: show brand (toggle is in toolbar) */
            <Link
              to={newSessionHref}
              className="sidebar-brand sidebar-brand-link"
              title={t("sidebarNewSession")}
            >
              <YepAnywhereLogo />
            </Link>
          ) : (
            /* Mobile mode: brand text + close button */
            <>
              <Link
                to={newSessionHref}
                className="sidebar-brand sidebar-brand-link"
                title={t("sidebarNewSession")}
                onClick={onNavigate}
              >
                <YepAnywhereLogo />
              </Link>
              <button
                type="button"
                className="sidebar-close"
                onClick={onClose}
                aria-label={t("actionCloseSidebar")}
              >
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  aria-hidden="true"
                >
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </>
          )}
        </div>

        <div className="sidebar-actions">
          {/* New Session: link to most recent project's new session page */}
          <SidebarNavItem
            to={newSessionPath}
            icon={SidebarIcons.newSession}
            label={t("sidebarNewSession")}
            onClick={onNavigate}
            basePath={basePath}
            hasDraft={hasNewSessionDraft && !isCollapsed}
          />
        </div>

        <div
          ref={sidebarSessionsRef}
          className="sidebar-sessions"
          onScroll={maybeLoadMoreSidebarSessions}
        >
          {/* Navigation items that scroll with content */}
          <SidebarNavSection>
            <SidebarNavItem
              to="/inbox"
              icon={SidebarIcons.inbox}
              label={t("sidebarInbox")}
              badge={inboxCount}
              onClick={onNavigate}
              basePath={basePath}
            />
            <SidebarNavItem
              to="/sessions"
              icon={SidebarIcons.allSessions}
              label={t("sidebarAllSessions")}
              onClick={onNavigate}
              basePath={basePath}
            />
            {bangHistoryVisible && (
              <SidebarNavItem
                to="/bang-commands"
                icon={SidebarIcons.bang}
                label={t("sidebarBangCommands")}
                onClick={onNavigate}
                basePath={basePath}
              />
            )}
            <SidebarNavItem
              to="/projects"
              icon={SidebarIcons.projects}
              label={t("sidebarProjects")}
              badge={supportsProjectQueue ? projectQueueSidebarCount : 0}
              badgeVariant="projectQueue"
              badgeTitle={t("projectCardQueueCount", {
                count: projectQueueSidebarCount,
              })}
              onClick={onNavigate}
              basePath={basePath}
            />
            {supportsSourceControl && (
              <SidebarNavItem
                to={sourceControlPath}
                icon={SidebarIcons.sourceControl}
                label={t("sidebarSourceControl")}
                onClick={onNavigate}
                basePath={basePath}
              />
            )}
            {supportsDeviceBridgeNav && (
              <SidebarNavItem
                to="/devices"
                icon={SidebarIcons.emulator}
                label={t("sidebarDevices")}
                onClick={onNavigate}
                basePath={basePath}
              />
            )}
            <AgentsNavItem onClick={onNavigate} basePath={basePath} />
            <SidebarNavItem
              to="/settings"
              icon={SidebarIcons.settings}
              label={t("sidebarSettings")}
              onClick={onNavigate}
              basePath={basePath}
            />
            {/* Relay-connected Switch Host uses nav-item markup so the mini rail stays icon-only. */}
            {remoteConnection && (
              <SidebarNavButton
                className="sidebar-switch-host"
                onClick={handleSwitchHost}
                label={t("sidebarSwitchHost")}
                icon={
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="17 1 21 5 17 9" />
                    <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                    <polyline points="7 23 3 19 7 15" />
                    <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                  </svg>
                }
              />
            )}
          </SidebarNavSection>

          {supportsProjectQueue && pendingProjectQueueItems.length > 0 && (
            <div className="sidebar-section">
              <SidebarSectionHeader
                title={t("sidebarSectionPendingSessions")}
                expanded={projectQueueExpanded}
                onToggle={() =>
                  setSidebarSectionExpanded("projectQueue", (prev) => !prev)
                }
                controlsId="sidebar-project-queue-list"
                expandLabel={t("sidebarSectionExpand")}
                collapseLabel={t("sidebarSectionCollapse")}
              />
              {projectQueueExpanded && (
                <ul
                  id="sidebar-project-queue-list"
                  className="sidebar-project-queue-list"
                >
                  {pendingProjectQueueItems.map((item) => {
                    const itemTitle =
                      item.target.title ||
                      item.messagePreview ||
                      t("projectQueueTargetNewSession");
                    const projectName =
                      projectNameById.get(item.projectId) ??
                      t("projectQueueUnknownProject");
                    return (
                      <li key={item.id}>
                        <Link
                          to={`${basePath}/projects?queueItem=${encodeURIComponent(
                            item.id,
                          )}`}
                          className={`sidebar-project-queue-item sidebar-project-queue-item--${item.status}`}
                          onClick={(event) =>
                            void handlePendingProjectQueueClick(event, item)
                          }
                          title={itemTitle}
                        >
                          <span className="sidebar-project-queue-item__main">
                            <span className="sidebar-project-queue-item__title">
                              {itemTitle}
                            </span>
                            <span className="sidebar-project-queue-item__project">
                              {projectName}
                            </span>
                          </span>
                          <span className="sidebar-project-queue-item__status">
                            {item.status === "failed"
                              ? t("projectQueueStatusFailed")
                              : t("projectQueueStatusQueued")}
                          </span>
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          )}

          {/* Global sessions list */}
          {filteredStarredSessions.length > 0 && (
            <div className="sidebar-section">
              <SidebarSectionHeader
                title={t("sidebarSectionStarred")}
                expanded={starredExpanded}
                onToggle={() =>
                  setSidebarSectionExpanded("starred", (prev) => !prev)
                }
                controlsId="sidebar-starred-list"
                expandLabel={t("sidebarSectionExpand")}
                collapseLabel={t("sidebarSectionCollapse")}
              />
              {starredExpanded && (
                <ul id="sidebar-starred-list" className="sidebar-session-list">
                  {filteredStarredSessions.map(renderCompactSession)}
                </ul>
              )}
            </div>
          )}

          {(recentPinned.length > 0 || visibleRecent.length > 0) && (
            <div className="sidebar-section">
              <SidebarSectionHeader
                title={t("sidebarSectionLast24Hours")}
                expanded={recentDayExpanded}
                onToggle={() =>
                  setSidebarSectionExpanded("recentDay", (prev) => !prev)
                }
                controlsId="sidebar-last-24-hours-list"
                expandLabel={t("sidebarSectionExpand")}
                collapseLabel={t("sidebarSectionCollapse")}
              />
              {recentDayExpanded && (
                <ul
                  id="sidebar-last-24-hours-list"
                  className="sidebar-session-list"
                >
                  {recentPinned.map(renderCompactSession)}
                  {visibleRecent.map(renderCompactSession)}
                  {hiddenRecent.length > 0 && (
                    <li className="sidebar-hidden-dups">
                      <button
                        type="button"
                        className="sidebar-hidden-dups-toggle"
                        onClick={() => setShowHiddenRecent((v) => !v)}
                        aria-expanded={showHiddenRecent}
                      >
                        {showHiddenRecent ? "−" : "+"}{" "}
                        {t("sidebarHiddenDuplicateSessions", {
                          count: hiddenRecent.length,
                        })}
                      </button>
                      {showHiddenRecent && (
                        <ul className="sidebar-session-list sidebar-hidden-sublist">
                          {hiddenRecent.map(renderCompactSession)}
                        </ul>
                      )}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {visibleOlder.length > 0 && (
            <div className="sidebar-section">
              <SidebarSectionHeader
                title={t("sidebarSectionOlder")}
                expanded={olderExpanded}
                onToggle={() =>
                  setSidebarSectionExpanded("older", (prev) => !prev)
                }
                controlsId="sidebar-older-list"
                expandLabel={t("sidebarSectionExpand")}
                collapseLabel={t("sidebarSectionCollapse")}
              />
              {olderExpanded && (
                <ul id="sidebar-older-list" className="sidebar-session-list">
                  {visibleOlder.map(renderCompactSession)}
                  {hiddenOlder.length > 0 && (
                    <li className="sidebar-hidden-dups">
                      <button
                        type="button"
                        className="sidebar-hidden-dups-toggle"
                        onClick={() => setShowHiddenOlder((v) => !v)}
                        aria-expanded={showHiddenOlder}
                      >
                        {showHiddenOlder ? "−" : "+"}{" "}
                        {t("sidebarHiddenDuplicateSessions", {
                          count: hiddenOlder.length,
                        })}
                      </button>
                      {showHiddenOlder && (
                        <ul className="sidebar-session-list sidebar-hidden-sublist">
                          {hiddenOlder.map(renderCompactSession)}
                        </ul>
                      )}
                    </li>
                  )}
                </ul>
              )}
            </div>
          )}

          {filteredStarredSessions.length === 0 &&
            pendingProjectQueueItems.length === 0 &&
            recentPinned.length === 0 &&
            visibleRecent.length === 0 &&
            visibleOlder.length === 0 && (
              <p className="sidebar-empty">
                {sessionsLoading
                  ? t("sidebarLoadingSessions")
                  : t("sidebarNoSessions")}
              </p>
            )}
        </div>

        {/* Resize handle - desktop only, when expanded */}
        {isDesktop && !isCollapsed && (
          <div
            className={`sidebar-resize-handle ${isResizing ? "active" : ""}`}
            onMouseDown={handleResizeMouseDown}
            role="separator"
            aria-orientation="vertical"
            aria-label={t("actionResizeSidebar")}
            aria-valuemin={SIDEBAR_MIN_WIDTH}
            aria-valuemax={SIDEBAR_MAX_WIDTH}
            aria-valuenow={sidebarWidth ?? SIDEBAR_MIN_WIDTH}
            tabIndex={0}
          />
        )}
      </aside>
    </>
  );
}
