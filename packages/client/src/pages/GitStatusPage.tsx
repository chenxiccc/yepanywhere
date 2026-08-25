import type {
  GitFileChange,
  GitIntegrationOptionReason,
  GitIntegrationOptionsResult,
  GitStatusInfo,
  GitUntrackedFileListResult,
  GitWorkingTreeFile,
} from "@yep-anywhere/shared";
import {
  PROJECT_CODE_NAMES_CAPABILITY,
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GIT_INCLUSIVE_TO_HEAD_CAPABILITY,
  GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  GIT_INCOMING_COMMITS_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
  GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
  GIT_WORKING_TREE_FILES_CAPABILITY,
  GIT_WORKING_TREE_SECTIONS_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { GlossaryProjectBoundary } from "../contexts/GlossaryContext";
import { SourceReviewDefaultSessionContext } from "../contexts/SourceReviewDefaultSessionContext";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useDocumentAttention } from "../hooks/useDocumentAttention";
import {
  formatRemoteCheckTime,
  type GitActionState,
  useGitActions,
} from "../hooks/useGitActions";
import { useGitStatus } from "../hooks/useGitStatus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import { useProject, useProjects } from "../hooks/useProjects";
import {
  ProjectWorktreePauseContext,
  useProjectWorktree,
} from "../hooks/useProjectWorktree";
import {
  resolvePreferredProjectId,
  setRecentProjectId,
} from "../hooks/useRecentProject";
import { useRelativeNow } from "../hooks/useRelativeNow";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useServerSettings } from "../hooks/useServerSettings";
import { useSourceControlCleanLanding } from "../hooks/useSourceControlCleanLanding";
import { useVersion } from "../hooks/useVersion";
import { type TranslationFn, useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import { toBrowserAppHref } from "../lib/appHref";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import {
  patchRouteRetention,
  type RouteRetentionKeyInput,
  readRouteRetention,
  subscribeRouteRetention,
} from "../lib/routeRetention";
import { parseSourceControlNavigationState } from "../lib/sourceControlNavigationState";
import { BlameBrowser } from "./BlameBrowser";
import { CommitBrowser } from "./CommitBrowser";
import styles from "./GitStatusPage.module.css";
import { RepoStatusBar } from "./RepoStatusBar";
import { ReviewCommentsPanel } from "./ReviewCommentsPanel";
import { ReviewSubmissionsPanel } from "./ReviewSubmissionsPanel";
import { ReviewSubmitModal } from "./ReviewSubmitModal";
import { SourceModeTabs, type SourceTab } from "./SourceModeTabs";
import { WorkingTreeBrowser } from "./WorkingTreeBrowser";

interface SourceControlRouteState {
  pageScrollTop?: number;
}

const SOURCE_CONTROL_ROUTE_TTL_MS = 5 * 60 * 1000;

/** Source-control modes with a built body (topic: source-review-to-session). */
const SOURCE_TABS: readonly SourceTab[] = ["changes", "files", "comments"];
const SOURCE_TABS_WITH_REVIEWS: readonly SourceTab[] = [
  ...SOURCE_TABS,
  "reviews",
];

/** URL keys that name a selection inside a mode, cleared when the mode changes. */
const SOURCE_SELECTION_PARAMS = [
  "tab",
  "history",
  "rev",
  "commitFile",
  "blame",
  "worktreeFile",
  "bf",
  "submission",
] as const;

function mergeLiveWorktreeStatus(
  status: GitStatusInfo | null,
  files: readonly GitWorkingTreeFile[],
): GitStatusInfo | null {
  if (!status) return null;
  const lastEditors = new Map(
    status.files.flatMap((file) =>
      file.lastEditor ? [[file.path, file.lastEditor] as const] : [],
    ),
  );
  const changes: GitFileChange[] = [];
  for (const file of files) {
    for (const change of file.worktreeChanges ?? []) {
      const lastEditor = change.lastEditor ?? lastEditors.get(file.path);
      changes.push({
        path: file.path,
        ...change,
        ...(lastEditor ? { lastEditor } : {}),
      });
    }
  }
  return { ...status, files: changes, isClean: changes.length === 0 };
}

/**
 * Source-mode tab state, derived from the `?tab=` URL param. Shared by the
 * title-row header actions (wide screens) and the status bar (mobile), so both
 * drive the same URL state.
 */
function useSourceTab(reviewsEnabled = false): {
  tab: SourceTab;
  setTab: (next: SourceTab) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const tabParam = searchParams.get("tab");
  const tab: SourceTab =
    tabParam === "files"
      ? "files"
      : tabParam === "comments"
        ? "comments"
        : tabParam === "reviews" && reviewsEnabled
          ? "reviews"
          : "changes";
  const setTab = useCallback(
    (next: SourceTab) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === "changes") params.delete("tab");
          else params.set("tab", next);
          params.delete("history");
          params.delete("rev");
          if (next !== "reviews") params.delete("submission");
          return params;
        },
        { state: location.state },
      );
    },
    [location.state, setSearchParams],
  );
  return { tab, setTab };
}

/**
 * Navigation from the identity header's branch name to the commit that branch
 * points at. The href is a real standalone URL so middle-click and "open in new
 * tab" work; plain left-click stays in this tab through the router.
 */
function useHeadCommitLink(
  projectId: string | undefined,
  status: GitStatusInfo | null | undefined,
  enabled: boolean,
): { headCommitHref?: string; onOpenHeadCommit?: () => void } {
  const basePath = useRemoteBasePath();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const headSha = status?.recentCommits?.[0]?.hash;
  const active = enabled && headSha !== undefined && projectId !== undefined;
  const headCommitHref = useMemo(() => {
    if (!active) return undefined;
    const params = new URLSearchParams(searchParams);
    params.set("projectId", projectId);
    for (const key of SOURCE_SELECTION_PARAMS) params.delete(key);
    params.set("rev", headSha);
    return toBrowserAppHref(`${basePath}/git-status?${params.toString()}`);
  }, [active, basePath, headSha, projectId, searchParams]);
  const onOpenHeadCommit = useCallback(() => {
    if (!active) return;
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        for (const key of SOURCE_SELECTION_PARAMS) params.delete(key);
        params.set("rev", headSha);
        return params;
      },
      { state: location.state },
    );
  }, [active, headSha, location.state, setSearchParams]);
  if (!active) return {};
  return { headCommitHref, onOpenHeadCommit };
}

/**
 * The single source-mode selector. It rides the wrapping header row, so the
 * browser decides whether it shares a line with project identity or takes one
 * of its own; `stacked` then lets it fill that row at phone widths.
 */
function SourceHeaderTabs({
  status,
  pendingCount,
  reviewsEnabled,
  supportsWorkingTreeFiles,
  t,
}: {
  status: GitStatusInfo;
  pendingCount: number;
  reviewsEnabled: boolean;
  supportsWorkingTreeFiles: boolean;
  t: TranslationFn;
}) {
  const { tab, setTab } = useSourceTab(reviewsEnabled);
  const changedFileCount = countChangedPaths(status);
  return (
    <SourceModeTabs
      tab={tab}
      tabs={reviewsEnabled ? SOURCE_TABS_WITH_REVIEWS : SOURCE_TABS}
      variant="stacked"
      counts={{ changes: changedFileCount, comments: pendingCount }}
      fileTabLabelKey={
        supportsWorkingTreeFiles ? "sourceTabWorkingTree" : undefined
      }
      onSelect={setTab}
      t={t}
    />
  );
}

function SourceHeaderActions({
  status,
  pendingCount,
  reviewsEnabled,
  supportsWorkingTreeFiles,
  worktreePaused,
  gitActions,
  isWideScreen,
  onToggleWorktreePaused,
  t,
}: {
  status: GitStatusInfo;
  pendingCount: number;
  reviewsEnabled: boolean;
  supportsWorkingTreeFiles: boolean;
  worktreePaused?: boolean;
  gitActions: GitActionState;
  isWideScreen: boolean;
  onToggleWorktreePaused?: () => void;
  t: TranslationFn;
}) {
  const controlsRef = useRef<HTMLDivElement>(null);
  const tabsRef = useRef<HTMLDivElement>(null);
  const [fitsTitleRow, setFitsTitleRow] = useState(false);

  useLayoutEffect(() => {
    if (!isWideScreen) {
      setFitsTitleRow(false);
      return undefined;
    }
    const controls = controlsRef.current;
    const tabs = tabsRef.current;
    const header = controls?.closest<HTMLElement>(".session-header-inner");
    const identity = header?.querySelector<HTMLElement>(".session-header-left");
    const actionGroup = controls?.querySelector<HTMLElement>(
      "[data-source-action-group]",
    );
    const tabList = tabs?.querySelector<HTMLElement>('[role="tablist"]');
    if (
      !controls ||
      !tabs ||
      !header ||
      !identity ||
      !actionGroup ||
      !tabList
    ) {
      return undefined;
    }

    const update = () => {
      const headerStyle = getComputedStyle(header);
      const available =
        header.clientWidth -
        cssPixels(headerStyle.paddingLeft) -
        cssPixels(headerStyle.paddingRight);
      const gap = cssPixels(headerStyle.columnGap);
      if (available <= 0) {
        setFitsTitleRow(false);
        return;
      }
      const demand =
        horizontalContentWidth(identity) +
        horizontalContentWidth(actionGroup) +
        horizontalContentWidth(tabList) +
        2 * gap;
      setFitsTitleRow(demand <= available + 0.5);
    };

    update();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(header);
    observer.observe(identity);
    observer.observe(actionGroup);
    observer.observe(tabList);
    return () => observer.disconnect();
  }, [isWideScreen]);

  return (
    <>
      <div
        ref={controlsRef}
        className={`${styles.headerControls} ${
          fitsTitleRow ? styles.titleRow : styles.fallbackRow
        }`}
        data-source-actions-placement={fitsTitleRow ? "title" : "fallback"}
      >
        <SourceHeaderControls
          gitActions={gitActions}
          worktreePaused={worktreePaused}
          onToggleWorktreePaused={onToggleWorktreePaused}
          t={t}
        />
      </div>
      <div ref={tabsRef} className={styles.headerTabs}>
        <SourceHeaderTabs
          status={status}
          pendingCount={pendingCount}
          reviewsEnabled={reviewsEnabled}
          supportsWorkingTreeFiles={supportsWorkingTreeFiles}
          t={t}
        />
      </div>
    </>
  );
}

function horizontalContentWidth(element: HTMLElement): number {
  const style = getComputedStyle(element);
  const children = Array.from(element.children).filter(
    (child): child is HTMLElement =>
      child instanceof HTMLElement &&
      getComputedStyle(child).display !== "none",
  );
  const childrenWidth = children.reduce(
    (total, child) =>
      total + Math.max(child.getBoundingClientRect().width, child.scrollWidth),
    0,
  );
  return (
    childrenWidth +
    Math.max(0, children.length - 1) * cssPixels(style.columnGap) +
    cssPixels(style.paddingLeft) +
    cssPixels(style.paddingRight) +
    cssPixels(style.borderLeftWidth) +
    cssPixels(style.borderRightWidth)
  );
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function SourceHeaderControls({
  gitActions,
  worktreePaused,
  onToggleWorktreePaused,
  t,
}: {
  gitActions: GitActionState;
  worktreePaused?: boolean;
  onToggleWorktreePaused?: () => void;
  t: TranslationFn;
}) {
  const nowMs = useRelativeNow();
  const remoteTitle = t("gitStatusLastCheckedRemote", {
    time: formatRemoteCheckTime(gitActions.checkedRemoteAt, nowMs, t),
  });
  return (
    <div className={styles.actionGroup} data-source-action-group>
      {gitActions.supportsPull && (
        <SourceActionButton
          action="pull"
          label={t("gitStatusPull")}
          runningLabel={t("gitStatusPulling")}
          running={gitActions.isPulling}
          feedback={gitActions.pullFeedback}
          tone={gitActions.pullFeedbackTone}
          onClick={gitActions.handlePull}
          disabled={gitActions.isRunning}
        />
      )}
      {gitActions.supportsPush && (
        <SourceActionButton
          action="push"
          label={t("gitStatusPush")}
          runningLabel={t("gitStatusPushing")}
          running={gitActions.isPushing}
          feedback={gitActions.pushFeedback}
          tone={gitActions.pushFeedbackTone}
          onClick={gitActions.handlePush}
          disabled={gitActions.isRunning}
        />
      )}
      {gitActions.supportsRemoteCheck && (
        <SourceActionButton
          action="check"
          label={t("gitStatusCheckRemote")}
          runningLabel={t("gitStatusCheckingRemote")}
          running={gitActions.isCheckingRemote}
          feedback={gitActions.checkFeedback}
          tone={gitActions.checkFeedbackTone}
          title={
            gitActions.checkFeedback
              ? `${gitActions.checkFeedback} · ${remoteTitle}`
              : remoteTitle
          }
          className={styles.checkRemote}
          onClick={gitActions.handleCheckRemote}
          disabled={gitActions.isRunning}
        />
      )}
      {onToggleWorktreePaused && (
        <button
          type="button"
          className="git-status-action-button"
          aria-pressed={worktreePaused}
          title={
            worktreePaused
              ? t("sourceResumeLiveUpdates")
              : t("sourcePauseLiveUpdates")
          }
          onClick={onToggleWorktreePaused}
        >
          <span className="git-status-action-indicator" aria-hidden="true">
            <SourceActionGlyph action={worktreePaused ? "play" : "pause"} />
          </span>
          <span className={styles.actionLabel}>
            {worktreePaused
              ? t("sourceResumeLiveUpdates")
              : t("sourcePauseLiveUpdates")}
          </span>
        </button>
      )}
    </div>
  );
}

function SourceActionButton({
  action,
  label,
  runningLabel,
  running,
  feedback,
  tone,
  title,
  className = "",
  onClick,
  disabled,
}: {
  action: "pull" | "push" | "check";
  label: string;
  runningLabel: string;
  running: boolean;
  feedback: string;
  tone: "success" | "warning" | null;
  title?: string;
  className?: string;
  onClick: () => void;
  disabled: boolean;
}) {
  const feedbackTitle = title ?? feedback;
  // The outcome shows on the button itself only briefly after an action
  // completes; the tooltip keeps the detail as long as the result stands.
  // Handlers reset results to null before each run, so feedback passes
  // through "" and retriggers this even when the outcome text repeats.
  const [recent, setRecent] = useState(false);
  useEffect(() => {
    if (!tone || !feedback) {
      setRecent(false);
      return;
    }
    setRecent(true);
    const timer = setTimeout(() => setRecent(false), 6000);
    return () => clearTimeout(timer);
  }, [tone, feedback]);
  const showOutcome = recent && tone !== null && feedback !== "";
  return (
    <button
      type="button"
      className={`git-status-action-button ${className} ${
        showOutcome ? `git-status-action-${tone}` : ""
      } ${running ? "git-status-action-running" : ""}`}
      title={feedbackTitle}
      aria-label={
        running
          ? `${label}: ${runningLabel}`
          : feedback
            ? `${label}: ${feedback}`
            : label
      }
      onClick={onClick}
      disabled={disabled}
    >
      <span className="git-status-action-indicator" aria-hidden="true">
        {running ? null : showOutcome ? (
          tone === "success" ? (
            "✓"
          ) : (
            "!"
          )
        ) : (
          <SourceActionGlyph action={action} />
        )}
      </span>
      <span className={styles.actionLabel}>{label}</span>
    </button>
  );
}

function SourceActionGlyph({
  action,
}: {
  action: "pull" | "push" | "check" | "pause" | "play";
}) {
  if (action === "pause") {
    return (
      <svg
        className="git-status-action-glyph"
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="currentColor"
      >
        <rect x="4" y="3" width="2.75" height="10" rx="0.6" />
        <rect x="9.25" y="3" width="2.75" height="10" rx="0.6" />
      </svg>
    );
  }
  if (action === "play") {
    return (
      <svg
        className="git-status-action-glyph"
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="currentColor"
      >
        <path d="M5 3.15 13 8 5 12.85Z" />
      </svg>
    );
  }
  if (action === "check") {
    return (
      <svg
        className="git-status-action-glyph"
        aria-hidden="true"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M13 5V2.5L11.4 4A5.5 5.5 0 1 0 13.1 10" />
      </svg>
    );
  }

  const isPull = action === "pull";
  return (
    <svg
      className="git-status-action-glyph"
      aria-hidden="true"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path
        d={
          isPull
            ? "M8 2v10M4.5 8.5 8 12l3.5-3.5"
            : "M8 14V4M4.5 7.5 8 4l3.5 3.5"
        }
      />
    </svg>
  );
}

function getSourceControlRouteRetentionKey(
  sourceKey: ClientSummarySourceKey,
  projectId: string,
): RouteRetentionKeyInput {
  return {
    sourceKey,
    routeId: "git-status",
    projectId,
    queryParams: { projectId },
  };
}

function updateSourceControlRouteState(
  key: RouteRetentionKeyInput,
  update: (current: SourceControlRouteState) => SourceControlRouteState,
): void {
  patchRouteRetention<SourceControlRouteState>(
    key,
    (current) => update(current ?? {}),
    { ttlMs: SOURCE_CONTROL_ROUTE_TTL_MS },
  );
}

function readSourceControlRouteState(
  key: RouteRetentionKeyInput,
): SourceControlRouteState | null {
  return readRouteRetention<SourceControlRouteState>(key, {
    touch: false,
    recordDiagnostics: false,
  });
}

function useSourceControlRouteState(
  key: RouteRetentionKeyInput | null,
): SourceControlRouteState | null {
  return useSyncExternalStore(
    subscribeRouteRetention,
    () => (key ? readSourceControlRouteState(key) : null),
    () => null,
  );
}

export function GitStatusPage() {
  const { t } = useI18n();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const sourceKey = useClientSummarySourceKey();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  const pageScrollRef = useRef<HTMLElement | null>(null);
  const [worktreePaused, setWorktreePaused] = useState(false);
  const documentAttentive = useDocumentAttention();
  const worktreeLeasePaused = worktreePaused || !documentAttentive;

  const { projects, loading: projectsLoading } = useProjects();
  const effectiveProjectId =
    projectId || resolvePreferredProjectId(projects) || undefined;
  const { project } = useProject(effectiveProjectId);
  const {
    version,
    loading: versionLoading,
    error: versionError,
  } = useVersion();
  const { settings: serverSettings } = useServerSettings();
  const reviewsEnabled =
    serverHasCapability(version, GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY) &&
    (serverSettings?.sourceReviewSubmissionsEnabled ?? false);
  const { setTab: setHeaderTab } = useSourceTab(reviewsEnabled);
  const supportsEnhancedGitStatus = serverHasCapability(
    version,
    GIT_STATUS_ENHANCED_CAPABILITY,
  );
  const supportsProjectCodeNames = serverHasCapability(
    version,
    PROJECT_CODE_NAMES_CAPABILITY,
  );
  const supportsLastEditor = serverHasCapability(
    version,
    GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  );
  const supportsSourceReview = serverHasCapability(
    version,
    GIT_SOURCE_REVIEW_CAPABILITY,
  );
  const supportsSourceReviewProjections = serverHasCapability(
    version,
    GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  );
  const supportsInclusiveToHead = serverHasCapability(
    version,
    GIT_INCLUSIVE_TO_HEAD_CAPABILITY,
  );
  const supportsWorkingTreeFiles = serverHasCapability(
    version,
    GIT_WORKING_TREE_FILES_CAPABILITY,
  );
  const supportsLiveWorktreeSetting = serverHasCapability(
    version,
    GIT_LIVE_WORKTREE_SETTING_CAPABILITY,
  );
  const supportsWorkingTreeSections =
    supportsLiveWorktreeSetting &&
    serverHasCapability(version, GIT_WORKING_TREE_SECTIONS_CAPABILITY);
  const supportsCompleteFilesystemScan =
    supportsWorkingTreeSections &&
    serverHasCapability(version, GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY);
  const supportsIncomingCommits = serverHasCapability(
    version,
    GIT_INCOMING_COMMITS_CAPABILITY,
  );
  const supportsRemoteCheck = serverHasCapability(
    version,
    GIT_STATUS_REMOTE_CHECK_CAPABILITY,
  );
  const supportsPull = serverHasCapability(version, GIT_STATUS_PULL_CAPABILITY);
  const supportsPush = serverHasCapability(version, GIT_STATUS_PUSH_CAPABILITY);
  const supportsIntegrationOptions = serverHasCapability(
    version,
    GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  );
  const {
    gitStatus: statusMetadata,
    untrackedFiles: legacyUntrackedFiles,
    loading: statusLoading,
    error: statusError,
    refetch,
  } = useGitStatus(supportsEnhancedGitStatus ? effectiveProjectId : undefined, {
    omitUntracked: supportsWorkingTreeSections,
    useUntrackedCache: supportsWorkingTreeFiles && !supportsWorkingTreeSections,
  });
  const liveWorktreeEnabled = Boolean(
    effectiveProjectId &&
      supportsWorkingTreeSections &&
      statusMetadata?.isGitRepo,
  );
  const liveWorktree = useProjectWorktree(
    effectiveProjectId ?? "",
    { tracked: true, untracked: true, ignored: false },
    liveWorktreeEnabled,
    worktreeLeasePaused,
  );
  const gitStatus = useMemo(
    () =>
      supportsWorkingTreeSections && liveWorktree.generation
        ? mergeLiveWorktreeStatus(statusMetadata, liveWorktree.files)
        : statusMetadata,
    [
      liveWorktree.files,
      liveWorktree.generation,
      statusMetadata,
      supportsWorkingTreeSections,
    ],
  );
  const untrackedFiles = supportsWorkingTreeSections
    ? null
    : legacyUntrackedFiles;
  const loading =
    statusLoading || (liveWorktreeEnabled && liveWorktree.loading);
  const error =
    statusError ??
    (liveWorktreeEnabled && liveWorktree.generation === null
      ? liveWorktree.error
      : null);
  const reviewComments = useProjectReviewComments(
    supportsSourceReview ? effectiveProjectId : undefined,
  );
  const headCommitLink = useHeadCommitLink(
    effectiveProjectId,
    gitStatus,
    supportsSourceReview,
  );
  const { defaultSession: routeDefaultSession } = useMemo(
    () => parseSourceControlNavigationState(location.state),
    [location.state],
  );
  const defaultSession =
    routeDefaultSession?.projectId === effectiveProjectId
      ? (routeDefaultSession ?? null)
      : null;
  const [showReviewModal, setShowReviewModal] = useState(false);
  const routeRetentionKey = useMemo(
    () =>
      effectiveProjectId
        ? getSourceControlRouteRetentionKey(sourceKey, effectiveProjectId)
        : null,
    [effectiveProjectId, sourceKey],
  );
  const retainedRouteState = useSourceControlRouteState(routeRetentionKey);
  const gitActions = useGitActions({
    projectId: effectiveProjectId,
    status: gitStatus,
    routeRetentionKey,
    supportsRemoteCheck,
    supportsPull,
    supportsPush,
    supportsIntegrationOptions,
    onRefreshStatus: refetch,
    t,
  });

  useDocumentTitle(
    project?.name,
    supportsProjectCodeNames ? project?.codeName : undefined,
    t("gitStatusTitle"),
  );

  useLayoutEffect(() => {
    void gitStatus?.files.length;
    const scrollTop = retainedRouteState?.pageScrollTop;
    if (typeof scrollTop !== "number" || !pageScrollRef.current) {
      return;
    }
    pageScrollRef.current.scrollTop = scrollTop;
  }, [gitStatus?.files.length, retainedRouteState?.pageScrollTop]);

  useLayoutEffect(() => {
    return () => {
      if (!routeRetentionKey || !pageScrollRef.current) {
        return;
      }
      updateSourceControlRouteState(routeRetentionKey, (current) => ({
        ...current,
        pageScrollTop: pageScrollRef.current?.scrollTop ?? 0,
      }));
    };
  }, [routeRetentionKey]);

  useEffect(() => {
    if (effectiveProjectId && project) {
      setRecentProjectId(effectiveProjectId);
    }
  }, [effectiveProjectId, project]);

  const handleProjectChange = (newProjectId: string) => {
    setRecentProjectId(newProjectId);
    setSearchParams(
      { projectId: newProjectId },
      { replace: true, state: null },
    );
  };

  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return <div className="error">{t("gitStatusNoProjects")}</div>;
  }

  return (
    <MainContent
      isWideScreen={isWideScreen}
      innerClassName={`source-control-main-content ${styles.sourceHeader}`}
    >
      <PageHeader
        title={project?.name ?? t("gitStatusTitle")}
        titleElement={
          effectiveProjectId ? (
            <div className="source-header-identity">
              <ProjectSelector
                currentProjectId={effectiveProjectId}
                currentProjectName={project?.name}
                onProjectChange={(p) => handleProjectChange(p.id)}
              />
              {gitStatus?.isGitRepo && (
                <RepoStatusBar
                  status={gitStatus}
                  projectId={effectiveProjectId}
                  supportsIncomingCommits={supportsIncomingCommits}
                  className="source-header-repo-status"
                  onSelectChanges={
                    supportsSourceReview
                      ? () => setHeaderTab("changes")
                      : undefined
                  }
                  {...headCommitLink}
                  t={t}
                />
              )}
            </div>
          ) : undefined
        }
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
        actions={
          supportsSourceReview && effectiveProjectId && gitStatus?.isGitRepo ? (
            <SourceHeaderActions
              status={gitStatus}
              pendingCount={reviewComments.pending.length}
              reviewsEnabled={reviewsEnabled}
              supportsWorkingTreeFiles={supportsWorkingTreeFiles}
              gitActions={gitActions}
              isWideScreen={isWideScreen}
              worktreePaused={worktreePaused}
              onToggleWorktreePaused={
                supportsWorkingTreeSections
                  ? () => setWorktreePaused((paused) => !paused)
                  : undefined
              }
              t={t}
            />
          ) : undefined
        }
      />

      <main className="page-scroll-container" ref={pageScrollRef}>
        <div className="page-content-inner">
          {versionLoading || projectsLoading ? (
            <div className="loading">{t("gitStatusLoading")}</div>
          ) : versionError ? (
            <div className="error">
              {t("gitStatusErrorPrefix")} {versionError.message}
            </div>
          ) : !supportsEnhancedGitStatus ? (
            <GitStatusUpgradeRequired t={t} />
          ) : loading ? (
            <div className="loading">{t("gitStatusLoading")}</div>
          ) : error ? (
            <div className="error">
              {t("gitStatusErrorPrefix")} {error.message}
            </div>
          ) : gitStatus &&
            !gitStatus.isGitRepo &&
            effectiveProjectId &&
            supportsWorkingTreeSections ? (
            <GlossaryProjectBoundary projectId={effectiveProjectId}>
              <ProjectWorktreePauseContext.Provider value={worktreeLeasePaused}>
                <div className="git-status">
                  <BlameBrowser
                    projectId={effectiveProjectId}
                    isWideScreen={isWideScreen}
                    status={gitStatus}
                    supportsWorkingTreeFiles={supportsWorkingTreeFiles}
                    supportsWorktreeSections
                    supportsCompleteFilesystemScan={
                      supportsCompleteFilesystemScan
                    }
                    t={t}
                  />
                </div>
              </ProjectWorktreePauseContext.Provider>
            </GlossaryProjectBoundary>
          ) : gitStatus && !gitStatus.isGitRepo ? (
            <div className="git-status-empty">{t("gitStatusNotRepo")}</div>
          ) : gitStatus && effectiveProjectId && supportsSourceReview ? (
            <GlossaryProjectBoundary projectId={effectiveProjectId}>
              <ProjectWorktreePauseContext.Provider value={worktreeLeasePaused}>
                <SourceReviewDefaultSessionContext.Provider
                  value={defaultSession}
                >
                  <GitStatusContent
                    key={`${sourceKey}:${effectiveProjectId}`}
                    status={gitStatus}
                    projectId={effectiveProjectId}
                    isWideScreen={isWideScreen}
                    supportsProjections={supportsSourceReviewProjections}
                    supportsInclusiveToHead={supportsInclusiveToHead}
                    supportsWorkingTreeFiles={supportsWorkingTreeFiles}
                    supportsWorkingTreeSections={supportsWorkingTreeSections}
                    supportsCompleteFilesystemScan={
                      supportsCompleteFilesystemScan
                    }
                    untrackedFiles={untrackedFiles}
                    supportsLastEditor={supportsLastEditor}
                    gitActions={gitActions}
                    reviewComments={reviewComments}
                    reviewsEnabled={reviewsEnabled}
                    showReviewModal={showReviewModal}
                    onOpenReview={() => setShowReviewModal(true)}
                    onCloseReview={() => setShowReviewModal(false)}
                    t={t}
                  />
                </SourceReviewDefaultSessionContext.Provider>
              </ProjectWorktreePauseContext.Provider>
            </GlossaryProjectBoundary>
          ) : gitStatus && effectiveProjectId ? (
            <GitStatusCompatibilityContent
              key={`${sourceKey}:${effectiveProjectId}:compatibility`}
              gitActions={gitActions}
              t={t}
            />
          ) : null}
        </div>
      </main>
    </MainContent>
  );
}

function GitStatusUpgradeRequired({ t }: { t: TranslationFn }) {
  return (
    <div className="git-status-upgrade">
      <h2>{t("gitStatusUpgradeRequiredTitle")}</h2>
      <p>{t("gitStatusUpgradeRequiredDescription")}</p>
    </div>
  );
}

function GitStatusCompatibilityContent({
  gitActions,
  t,
}: {
  gitActions: GitActionState;
  t: TranslationFn;
}) {
  return (
    <div className="git-status git-status-compatibility">
      <div
        className={`source-control-action-row ${styles.compatibilityActions}`}
      >
        <SourceHeaderControls gitActions={gitActions} t={t} />
      </div>
      <GitActionNotices gitActions={gitActions} t={t} />
      <section className="git-status-compatibility-notice">
        <h2>{t("gitStatusCompatibilityTitle")}</h2>
        <p>{t("gitStatusCompatibilityDescription")}</p>
      </section>
    </div>
  );
}

function GitStatusContent({
  status,
  projectId,
  isWideScreen,
  supportsProjections,
  supportsInclusiveToHead,
  supportsWorkingTreeFiles,
  supportsWorkingTreeSections,
  supportsCompleteFilesystemScan,
  untrackedFiles,
  supportsLastEditor,
  gitActions,
  reviewComments,
  reviewsEnabled,
  showReviewModal,
  onOpenReview,
  onCloseReview,
  t,
}: {
  status: GitStatusInfo;
  projectId: string;
  isWideScreen: boolean;
  supportsProjections: boolean;
  supportsInclusiveToHead: boolean;
  supportsWorkingTreeFiles: boolean;
  supportsWorkingTreeSections: boolean;
  supportsCompleteFilesystemScan: boolean;
  untrackedFiles: GitUntrackedFileListResult | null;
  supportsLastEditor: boolean;
  gitActions: GitActionState;
  reviewComments: ReturnType<typeof useProjectReviewComments>;
  reviewsEnabled: boolean;
  showReviewModal: boolean;
  onOpenReview: () => void;
  onCloseReview: () => void;
  t: TranslationFn;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = useRemoteBasePath();
  const [searchParams, setSearchParams] = useSearchParams();
  const { tab } = useSourceTab(reviewsEnabled);
  const blameFile = searchParams.get("bf") ?? undefined;
  const commitSha = searchParams.get("rev") ?? undefined;
  const commitFile = searchParams.get("commitFile") ?? undefined;
  const commitBlame = searchParams.get("blame") === "1";
  const worktreeFile = searchParams.get("worktreeFile") ?? undefined;
  const { sourceControlCleanLanding } = useSourceControlCleanLanding();
  const historyOpen =
    tab === "changes" &&
    (searchParams.get("history") === "1" ||
      searchParams.get("tab") === "commits" ||
      (commitSha === undefined &&
        status.isClean &&
        worktreeFile === undefined &&
        sourceControlCleanLanding === "latest-commit"));
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [showProjectionNotice, setShowProjectionNotice] = useState(false);
  const projectionNoticeNeedsPortal = useMediaQuery("(max-width: 600px)");
  const activeIgnoreWhitespace = supportsProjections && ignoreWhitespace;
  useEffect(() => {
    if (!supportsProjections) setIgnoreWhitespace(false);
  }, [supportsProjections]);
  const handleProjectionUnavailable = useCallback(() => {
    setIgnoreWhitespace(false);
    setShowProjectionNotice(true);
  }, []);
  const handleToggleIgnoreWhitespace = useCallback(() => {
    if (!ignoreWhitespace && !supportsProjections) {
      setShowProjectionNotice(true);
      return;
    }
    setIgnoreWhitespace(!ignoreWhitespace);
  }, [ignoreWhitespace, supportsProjections]);
  const projectionNotice = showProjectionNotice ? (
    <div className="source-projection-notice" role="status">
      <span>{t("sourceProjectionUpgradeNotice")}</span>
      <button
        type="button"
        className="source-projection-notice-dismiss"
        aria-label={t("sourceDismissProjectionNotice")}
        onClick={() => setShowProjectionNotice(false)}
      >
        ×
      </button>
    </div>
  ) : null;
  // Bridge a commit file to its blame-at-HEAD view: switch to the files tab
  // with that file seeded open (a real history step, so back returns).
  const handleBlameFile = useCallback(
    (path: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set("tab", "files");
          params.set("bf", path);
          return params;
        },
        { state: location.state },
      );
    },
    [location.state, setSearchParams],
  );
  const handleOpenCommit = useCallback(
    (sha: string) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.delete("tab");
          params.delete("history");
          params.set("rev", sha);
          return params;
        },
        { state: location.state },
      );
    },
    [location.state, setSearchParams],
  );
  const focusedRevisionHref = useCallback(
    (sha: string | null) => {
      const params = new URLSearchParams(searchParams);
      params.set("projectId", projectId);
      for (const key of SOURCE_SELECTION_PARAMS) params.delete(key);
      if (sha) params.set("rev", sha);
      return toBrowserAppHref(`${basePath}/git-status?${params.toString()}`);
    },
    [basePath, projectId, searchParams],
  );
  const handleSelectRevision = useCallback(
    (sha: string | null) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          for (const key of SOURCE_SELECTION_PARAMS) params.delete(key);
          if (historyOpen) params.set("history", "1");
          if (sha) params.set("rev", sha);
          return params;
        },
        { state: location.state },
      );
    },
    [historyOpen, location.state, setSearchParams],
  );
  const handleBrowseHistory = useCallback(() => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete("tab");
        params.set("history", "1");
        return params;
      },
      { state: location.state },
    );
  }, [location.state, setSearchParams]);
  return (
    <div className="git-status">
      <GitActionNotices gitActions={gitActions} t={t} />
      {projectionNotice &&
        (projectionNoticeNeedsPortal
          ? createPortal(projectionNotice, document.body)
          : projectionNotice)}

      {tab === "changes" && !historyOpen && !commitSha ? (
        <WorkingTreeBrowser
          projectId={projectId}
          status={status}
          isWideScreen={isWideScreen}
          supportsUntrackedCache={
            supportsWorkingTreeFiles && !supportsWorkingTreeSections
          }
          untrackedFiles={untrackedFiles}
          initialWorkingTreePath={worktreeFile}
          onBrowseHistory={handleBrowseHistory}
          onBlameFile={handleBlameFile}
          captureReviewProjections={reviewsEnabled}
          supportsLastEditor={supportsLastEditor}
          ignoreWhitespace={activeIgnoreWhitespace}
          onToggleIgnoreWhitespace={handleToggleIgnoreWhitespace}
          onProjectionRequestFailure={handleProjectionUnavailable}
          t={t}
        />
      ) : tab === "changes" ? (
        <CommitBrowser
          projectId={projectId}
          status={status}
          isWideScreen={isWideScreen}
          supportsUntrackedCache={
            supportsWorkingTreeFiles && !supportsWorkingTreeSections
          }
          untrackedFiles={untrackedFiles}
          initialSha={commitSha}
          initialPath={commitFile}
          initialBlame={commitBlame}
          showRevisionPane={historyOpen}
          revisionHref={focusedRevisionHref}
          onSelectRevision={handleSelectRevision}
          onBrowseHistory={handleBrowseHistory}
          onBlameFile={handleBlameFile}
          captureReviewProjections={reviewsEnabled}
          supportsProjections={supportsProjections}
          supportsInclusiveToHead={supportsInclusiveToHead}
          supportsLastEditor={supportsLastEditor}
          ignoreWhitespace={activeIgnoreWhitespace}
          onToggleIgnoreWhitespace={handleToggleIgnoreWhitespace}
          onProjectionUnavailable={handleProjectionUnavailable}
          t={t}
        />
      ) : tab === "comments" ? (
        <ReviewCommentsPanel
          projectId={projectId}
          pending={reviewComments.pending}
          onOpenFile={handleBlameFile}
          onSubmit={onOpenReview}
          t={t}
        />
      ) : tab === "reviews" ? (
        <ReviewSubmissionsPanel
          projectId={projectId}
          initialSubmissionId={searchParams.get("submission") ?? undefined}
          sessionHref={(sessionId) =>
            `${basePath}/projects/${projectId}/sessions/${sessionId}`
          }
          t={t}
        />
      ) : tab === "files" ? (
        <BlameBrowser
          projectId={projectId}
          isWideScreen={isWideScreen}
          initialPath={blameFile}
          status={status}
          supportsWorkingTreeFiles={supportsWorkingTreeFiles}
          supportsWorktreeSections={supportsWorkingTreeSections}
          supportsCompleteFilesystemScan={supportsCompleteFilesystemScan}
          onOpenCommit={handleOpenCommit}
          captureReviewProjections={reviewsEnabled}
          t={t}
        />
      ) : null}

      {showReviewModal && (
        <ReviewSubmitModal
          projectId={projectId}
          recentReviewSessionId={reviewComments.recentReviewSessionId}
          submissionsEnabled={reviewsEnabled}
          onClose={onCloseReview}
          onNavigateSession={(sessionId) =>
            navigate(`${basePath}/projects/${projectId}/sessions/${sessionId}`)
          }
          t={t}
        />
      )}
    </div>
  );
}

function countChangedPaths(status: GitStatusInfo): number {
  return new Set(status.files.map((file) => file.path)).size;
}

function GitActionNotices({
  gitActions,
  t,
}: {
  gitActions: GitActionState;
  t: TranslationFn;
}) {
  const showIntegrationOptions =
    gitActions.divergedActionStatus && gitActions.supportsIntegrationOptions;
  if (!gitActions.actionFeedback && !showIntegrationOptions) {
    return null;
  }

  return (
    <div className="git-status-action-notices">
      {gitActions.actionFeedback && gitActions.actionFeedbackTone && (
        <div
          className={`git-status-action-message git-status-action-message-${gitActions.actionFeedbackTone}`}
          role={
            gitActions.actionFeedbackTone === "warning" ? "alert" : "status"
          }
        >
          {gitActions.actionFeedback}
        </div>
      )}
      {showIntegrationOptions && (
        <GitIntegrationOptionsPanel
          options={gitActions.integrationOptions}
          loading={gitActions.isLoadingIntegrationOptions}
          error={gitActions.integrationOptionsError}
          t={t}
        />
      )}
    </div>
  );
}

function GitIntegrationOptionsPanel({
  options,
  loading,
  error,
  t,
}: {
  options: GitIntegrationOptionsResult | null;
  loading: boolean;
  error: string | null;
  t: TranslationFn;
}) {
  if (loading) {
    return (
      <div className="git-integration-options">
        <span>{t("gitStatusAutoOptionsChecking")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="git-integration-options git-integration-options-warning">
        <span>{error}</span>
      </div>
    );
  }

  if (!options) {
    return null;
  }

  if (options.status === "available") {
    return (
      <div className="git-integration-options">
        <span className="git-integration-options-label">
          {t("gitStatusAutoOptionsLabel")}
        </span>
        <span
          className="git-integration-option-pill"
          aria-disabled="true"
          title={t("gitStatusAutoActionNotEnabled")}
        >
          {t("gitStatusAutoRebase")}
        </span>
        <span
          className="git-integration-option-pill"
          aria-disabled="true"
          title={t("gitStatusAutoActionNotEnabled")}
        >
          {t("gitStatusAutoMerge")}
        </span>
        <GitIntegrationOptionsHelp t={t} />
      </div>
    );
  }

  return (
    <div className="git-integration-options git-integration-options-warning">
      <span>
        {t("gitStatusAutoOptionsUnavailable", {
          reason: getIntegrationUnavailableReason(options.reasons, t),
        })}
      </span>
      <GitIntegrationOptionsHelp t={t} />
    </div>
  );
}

function GitIntegrationOptionsHelp({ t }: { t: TranslationFn }) {
  return (
    <details className="git-integration-help">
      <summary
        aria-label={t("gitStatusAutoHelpLabel")}
        title={t("gitStatusAutoHelpLabel")}
      >
        ?
      </summary>
      <div className="git-integration-help-popover">
        {t("gitStatusAutoHelp")}
      </div>
    </details>
  );
}

const INTEGRATION_REASON_PRIORITY: GitIntegrationOptionReason[] = [
  "operation-running",
  "sequencer-in-progress",
  "dirty-worktree",
  "missing-upstream",
  "detached-head",
  "not-diverged",
  "not-a-git-repo",
  "status-unavailable",
];

function getIntegrationUnavailableReason(
  reasons: GitIntegrationOptionReason[],
  t: TranslationFn,
): string {
  const reason =
    INTEGRATION_REASON_PRIORITY.find((candidate) =>
      reasons.includes(candidate),
    ) ?? "status-unavailable";

  switch (reason) {
    case "operation-running":
      return t("gitStatusAutoReasonOperationRunning");
    case "sequencer-in-progress":
      return t("gitStatusAutoReasonSequencer");
    case "dirty-worktree":
      return t("gitStatusAutoReasonDirty");
    case "missing-upstream":
      return t("gitStatusAutoReasonMissingUpstream");
    case "detached-head":
      return t("gitStatusAutoReasonDetached");
    case "not-diverged":
      return t("gitStatusAutoReasonNotDiverged");
    case "not-a-git-repo":
      return t("gitStatusAutoReasonNotRepo");
    case "status-unavailable":
      return t("gitStatusAutoReasonStatusUnavailable");
    default:
      return t("gitStatusAutoReasonStatusUnavailable");
  }
}
