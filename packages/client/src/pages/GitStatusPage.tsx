import type {
  GitIntegrationOptionReason,
  GitIntegrationOptionsResult,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import {
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
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
import { useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import {
  type GitActionState,
  formatRemoteCheckTime,
  useGitActions,
} from "../hooks/useGitActions";
import { useGitStatus } from "../hooks/useGitStatus";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProject, useProjects } from "../hooks/useProjects";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import { useRelativeNow } from "../hooks/useRelativeNow";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { BlameBrowser } from "./BlameBrowser";
import { CommitBrowser } from "./CommitBrowser";
import { RepoStatusBar } from "./RepoStatusBar";
import { ReviewCommentsPanel } from "./ReviewCommentsPanel";
import { type SourceTab, SourceModeTabs } from "./SourceModeTabs";
import { ReviewSubmitModal } from "./ReviewSubmitModal";
import {
  resolvePreferredProjectId,
  setRecentProjectId,
} from "../hooks/useRecentProject";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { MainContent, useNavigationLayout } from "../layouts";
import {
  type ClientSummarySourceKey,
  useClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import {
  patchRouteRetention,
  readRouteRetention,
  subscribeRouteRetention,
  type RouteRetentionKeyInput,
} from "../lib/routeRetention";

interface SourceControlRouteState {
  pageScrollTop?: number;
}

const SOURCE_CONTROL_ROUTE_TTL_MS = 5 * 60 * 1000;

/** Source-control modes with a built body (topic: source-review-to-session). */
const SOURCE_TABS: readonly SourceTab[] = ["commits", "files", "comments"];

/**
 * Source-mode tab state, derived from the `?tab=` URL param. Shared by the
 * title-row header actions (wide screens) and the status bar (mobile), so both
 * drive the same URL state.
 */
function useSourceTab(): {
  tab: SourceTab;
  setTab: (next: SourceTab) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: SourceTab =
    tabParam === "files"
      ? "files"
      : tabParam === "comments"
        ? "comments"
        : "commits";
  const setTab = useCallback(
    (next: SourceTab) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === "commits") params.delete("tab");
          else params.set("tab", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  return { tab, setTab };
}


/**
 * The mode tabs rendered in the page-header row on wide screens, so the
 * selector shares the title/project row instead of stacking a second toolbar
 * beneath it (the mobile stack keeps them in the status bar).
 */
function SourceHeaderActions({
  status,
  pendingCount,
  onOpenReview,
  gitActions,
  t,
}: {
  status: GitStatusInfo;
  pendingCount: number;
  onOpenReview: () => void;
  gitActions: GitActionState;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const { tab, setTab } = useSourceTab();
  return (
    <RepoStatusBar
      status={status}
      inline
      tabs={
        <SourceModeTabs
          tab={tab}
          tabs={SOURCE_TABS}
          counts={{ comments: pendingCount }}
          onSelect={setTab}
          t={t}
        />
      }
      actions={
        <SourceHeaderControls
          gitActions={gitActions}
          pendingCount={pendingCount}
          compact
          onReview={() => {
            if (pendingCount > 0) onOpenReview();
            else setTab("comments");
          }}
          t={t}
        />
      }
      t={t}
    />
  );
}

function SourceHeaderControls({
  gitActions,
  pendingCount,
  compact = false,
  onReview,
  t,
}: {
  gitActions: GitActionState;
  pendingCount: number;
  compact?: boolean;
  onReview: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const nowMs = useRelativeNow();
  const remoteTitle = t("gitStatusLastCheckedRemote", {
    time: formatRemoteCheckTime(gitActions.checkedRemoteAt, nowMs, t),
  });
  const pullLabel = gitActions.isPulling
    ? t("gitStatusPulling")
    : t("gitStatusPull");
  const pushLabel = gitActions.isPushing
    ? t("gitStatusPushing")
    : t("gitStatusPush");
  const checkLabel = gitActions.isCheckingRemote
    ? t("gitStatusCheckingRemote")
    : t(compact ? "gitStatusCheckRemoteShort" : "gitStatusCheckRemote");
  return (
    <div className="repo-status-action-group">
      {gitActions.supportsPull && (
        <SourceActionButton
          label={pullLabel}
          feedback={gitActions.pullFeedback}
          tone={gitActions.pullFeedbackTone}
          onClick={gitActions.handlePull}
          disabled={gitActions.isRunning}
        />
      )}
      {gitActions.supportsPush && (
        <SourceActionButton
          label={pushLabel}
          feedback={gitActions.pushFeedback}
          tone={gitActions.pushFeedbackTone}
          onClick={gitActions.handlePush}
          disabled={gitActions.isRunning}
        />
      )}
      {gitActions.supportsRemoteCheck && (
        <SourceActionButton
          label={checkLabel}
          feedback={gitActions.checkFeedback}
          tone={gitActions.checkFeedbackTone}
          title={
            gitActions.checkFeedback
              ? `${gitActions.checkFeedback} · ${remoteTitle}`
              : remoteTitle
          }
          className="git-status-check-remote"
          onClick={gitActions.handleCheckRemote}
          disabled={gitActions.isRunning}
        />
      )}
      <button
        type="button"
        className="git-status-action-button review-tray-button"
        onClick={onReview}
      >
        {pendingCount > 0
          ? t("sourceReviewReview", { count: pendingCount })
          : t("sourceReviewStart")}
      </button>
    </div>
  );
}

function SourceActionButton({
  label,
  feedback,
  tone,
  title,
  className = "",
  onClick,
  disabled,
}: {
  label: string;
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
      }`}
      title={feedbackTitle}
      aria-label={feedback ? `${label}: ${feedback}` : label}
      onClick={onClick}
      disabled={disabled}
    >
      <span>{label}</span>
      {showOutcome && (
        <span className="git-status-action-indicator" aria-hidden="true">
          {tone === "success" ? "✓" : "!"}
        </span>
      )}
    </button>
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
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const sourceKey = useClientSummarySourceKey();
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();
  // Header composition is independent from the 1100px multipane breakpoint:
  // tablet widths can fit one compact banner even though their content panes
  // still use the mobile drill-in flow.
  const sourceControlsFitHeader = useMediaQuery("(min-width: 760px)");
  const pageScrollRef = useRef<HTMLElement | null>(null);

  const { projects, loading: projectsLoading } = useProjects();
  const effectiveProjectId =
    projectId || resolvePreferredProjectId(projects) || undefined;
  const { project } = useProject(effectiveProjectId);
  const {
    version,
    loading: versionLoading,
    error: versionError,
  } = useVersion();
  const supportsEnhancedGitStatus = serverHasCapability(
    version,
    GIT_STATUS_ENHANCED_CAPABILITY,
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
  const { gitStatus, loading, error, refetch } = useGitStatus(
    supportsEnhancedGitStatus ? effectiveProjectId : undefined,
  );
  const reviewComments = useProjectReviewComments(effectiveProjectId);
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
    t: t as never,
  });

  useDocumentTitle(project?.name, t("gitStatusTitle"));

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
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return <div className="error">{t("gitStatusNoProjects")}</div>;
  }

  return (
    <MainContent
      isWideScreen={isWideScreen}
      innerClassName="source-control-main-content"
    >
      <PageHeader
        title={project?.name ?? t("gitStatusTitle")}
        titleElement={
          effectiveProjectId ? (
            <ProjectSelector
              currentProjectId={effectiveProjectId}
              currentProjectName={project?.name}
              onProjectChange={(p) => handleProjectChange(p.id)}
            />
          ) : undefined
        }
        onOpenSidebar={openSidebar}
        onToggleSidebar={toggleSidebar}
        isWideScreen={isWideScreen}
        isSidebarCollapsed={isSidebarCollapsed}
        actions={
          sourceControlsFitHeader &&
          effectiveProjectId &&
          gitStatus?.isGitRepo ? (
            <SourceHeaderActions
              status={gitStatus}
              pendingCount={reviewComments.pending.length}
              onOpenReview={() => setShowReviewModal(true)}
              gitActions={gitActions}
              t={t as never}
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
            <GitStatusUpgradeRequired t={t as never} />
          ) : loading ? (
            <div className="loading">{t("gitStatusLoading")}</div>
          ) : error ? (
            <div className="error">
              {t("gitStatusErrorPrefix")} {error.message}
            </div>
          ) : gitStatus && !gitStatus.isGitRepo ? (
            <div className="git-status-empty">{t("gitStatusNotRepo")}</div>
          ) : gitStatus && effectiveProjectId ? (
            <GitStatusContent
              key={`${sourceKey}:${effectiveProjectId}`}
              status={gitStatus}
              projectId={effectiveProjectId}
              projectName={project?.name}
              isWideScreen={isWideScreen}
              sourceControlsFitHeader={sourceControlsFitHeader}
              gitActions={gitActions}
              reviewComments={reviewComments}
              showReviewModal={showReviewModal}
              onOpenReview={() => setShowReviewModal(true)}
              onCloseReview={() => setShowReviewModal(false)}
              t={t as never}
            />
          ) : null}
        </div>
      </main>
    </MainContent>
  );
}

function GitStatusUpgradeRequired({
  t,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <div className="git-status-upgrade">
      <h2>{t("gitStatusUpgradeRequiredTitle")}</h2>
      <p>{t("gitStatusUpgradeRequiredDescription")}</p>
    </div>
  );
}

function GitStatusContent({
  status,
  projectId,
  projectName,
  isWideScreen,
  sourceControlsFitHeader,
  gitActions,
  reviewComments,
  showReviewModal,
  onOpenReview,
  onCloseReview,
  t,
}: {
  status: GitStatusInfo;
  projectId: string;
  projectName?: string;
  isWideScreen: boolean;
  sourceControlsFitHeader: boolean;
  gitActions: GitActionState;
  reviewComments: ReturnType<typeof useProjectReviewComments>;
  showReviewModal: boolean;
  onOpenReview: () => void;
  onCloseReview: () => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const [searchParams, setSearchParams] = useSearchParams();
  const { tab, setTab } = useSourceTab();
  const blameFile = searchParams.get("bf") ?? undefined;
  // Bridge a commit file to its blame-at-HEAD view: switch to the files tab
  // with that file seeded open (a real history step, so back returns).
  const handleBlameFile = useCallback(
    (path: string) => {
      setSearchParams((prev) => {
        const params = new URLSearchParams(prev);
        params.set("tab", "files");
        params.set("bf", path);
        return params;
      });
    },
    [setSearchParams],
  );
  return (
    <div className="git-status">
      {!sourceControlsFitHeader && (
        <RepoStatusBar
          repoName={projectName}
          status={status}
          tabs={
            <SourceModeTabs
              tab={tab}
              tabs={SOURCE_TABS}
              counts={{ comments: reviewComments.pending.length }}
              onSelect={setTab}
              t={t}
            />
          }
          actions={
            <SourceHeaderControls
              gitActions={gitActions}
              pendingCount={reviewComments.pending.length}
              onReview={() => {
                if (reviewComments.pending.length > 0) onOpenReview();
                else setTab("comments");
              }}
              t={t}
            />
          }
          t={t}
        />
      )}

      {tab === "commits" ? (
        <CommitBrowser
          projectId={projectId}
          status={status}
          isWideScreen={isWideScreen}
          onBlameFile={handleBlameFile}
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
      ) : tab === "files" ? (
        <BlameBrowser
          projectId={projectId}
          isWideScreen={isWideScreen}
          initialPath={blameFile}
          t={t}
        />
      ) : null}

      {gitActions.divergedActionStatus &&
        gitActions.supportsIntegrationOptions && (
          <GitIntegrationOptionsPanel
            options={gitActions.integrationOptions}
            loading={gitActions.isLoadingIntegrationOptions}
            error={gitActions.integrationOptionsError}
            t={t}
          />
        )}

      {showReviewModal && (
        <ReviewSubmitModal
          projectId={projectId}
          recentReviewSessionId={reviewComments.recentReviewSessionId}
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


function GitIntegrationOptionsPanel({
  options,
  loading,
  error,
  t,
}: {
  options: GitIntegrationOptionsResult | null;
  loading: boolean;
  error: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
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

function GitIntegrationOptionsHelp({
  t,
}: {
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
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
  t: (key: string, vars?: Record<string, string | number>) => string,
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
