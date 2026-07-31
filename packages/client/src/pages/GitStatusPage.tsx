import type {
  GitIntegrationOptionReason,
  GitIntegrationOptionsResult,
  GitStatusInfo,
} from "@yep-anywhere/shared";
import {
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
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
import { createPortal } from "react-dom";
import { useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { SourceReviewDefaultSessionContext } from "../contexts/SourceReviewDefaultSessionContext";
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
import { WorkingTreeBrowser } from "./WorkingTreeBrowser";
import { ReviewSubmitModal } from "./ReviewSubmitModal";
import {
  resolvePreferredProjectId,
  setRecentProjectId,
} from "../hooks/useRecentProject";
import { useVersion } from "../hooks/useVersion";
import { type TranslationFn, useI18n } from "../i18n";
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
import { parseSourceControlNavigationState } from "../lib/sourceControlNavigationState";

interface SourceControlRouteState {
  pageScrollTop?: number;
}

const SOURCE_CONTROL_ROUTE_TTL_MS = 5 * 60 * 1000;

/** Source-control modes with a built body (topic: source-review-to-session). */
const SOURCE_TABS: readonly SourceTab[] = [
  "changes",
  "files",
  "comments",
];

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
  const location = useLocation();
  const tabParam = searchParams.get("tab");
  const tab: SourceTab =
    tabParam === "files"
      ? "files"
      : tabParam === "comments"
        ? "comments"
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
          return params;
        },
        { replace: true, state: location.state },
      );
    },
    [location.state, setSearchParams],
  );
  return { tab, setTab };
}

/** Source-mode tabs rendered at the top-right when the header can fit them. */
function SourceHeaderTabs({
  status,
  pendingCount,
  t,
}: {
  status: GitStatusInfo;
  pendingCount: number;
  t: TranslationFn;
}) {
  const { tab, setTab } = useSourceTab();
  const changedFileCount = countChangedPaths(status);
  return (
    <SourceModeTabs
      tab={tab}
      tabs={SOURCE_TABS}
      counts={{ changes: changedFileCount, comments: pendingCount }}
      onSelect={setTab}
      t={t}
    />
  );
}

function SourceHeaderControls({
  gitActions,
  pendingCount,
  onReview,
  t,
}: {
  gitActions: GitActionState;
  pendingCount?: number;
  onReview?: () => void;
  t: TranslationFn;
}) {
  const nowMs = useRelativeNow();
  const remoteTitle = t("gitStatusLastCheckedRemote", {
    time: formatRemoteCheckTime(gitActions.checkedRemoteAt, nowMs, t),
  });
  return (
    <div className="repo-status-action-group">
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
          className="git-status-check-remote"
          onClick={gitActions.handleCheckRemote}
          disabled={gitActions.isRunning}
        />
      )}
      {onReview && pendingCount !== undefined && (
        <button
          type="button"
          className="git-status-action-button review-tray-button"
          onClick={onReview}
        >
          {pendingCount > 0
            ? t("sourceReviewReview", { count: pendingCount })
            : t("sourceReviewStart")}
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
      <span
        className="git-status-action-indicator"
        aria-hidden="true"
      >
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
      <span className="git-status-action-label">{label}</span>
    </button>
  );
}

function SourceActionGlyph({
  action,
}: {
  action: "pull" | "push" | "check";
}) {
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
  const { setTab: setHeaderTab } = useSourceTab();
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
  const supportsSourceReview = serverHasCapability(
    version,
    GIT_SOURCE_REVIEW_CAPABILITY,
  );
  const supportsSourceReviewProjections = serverHasCapability(
    version,
    GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
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
  const reviewComments = useProjectReviewComments(
    supportsSourceReview ? effectiveProjectId : undefined,
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
      innerClassName="source-control-main-content"
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
                  className="source-header-repo-status"
                  onSelectChanges={
                    supportsSourceReview
                      ? () => setHeaderTab("changes")
                      : undefined
                  }
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
          sourceControlsFitHeader &&
          supportsSourceReview &&
          effectiveProjectId &&
          gitStatus?.isGitRepo ? (
            <SourceHeaderTabs
              status={gitStatus}
              pendingCount={reviewComments.pending.length}
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
          ) : gitStatus && !gitStatus.isGitRepo ? (
            <div className="git-status-empty">{t("gitStatusNotRepo")}</div>
          ) : gitStatus && effectiveProjectId && supportsSourceReview ? (
            <SourceReviewDefaultSessionContext.Provider value={defaultSession}>
              <GitStatusContent
                key={`${sourceKey}:${effectiveProjectId}`}
                status={gitStatus}
                projectId={effectiveProjectId}
                isWideScreen={isWideScreen}
                sourceControlsFitHeader={sourceControlsFitHeader}
                supportsProjections={supportsSourceReviewProjections}
                gitActions={gitActions}
                reviewComments={reviewComments}
                showReviewModal={showReviewModal}
                onOpenReview={() => setShowReviewModal(true)}
                onCloseReview={() => setShowReviewModal(false)}
                t={t}
              />
            </SourceReviewDefaultSessionContext.Provider>
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
      <div className="source-control-action-row">
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
  sourceControlsFitHeader,
  supportsProjections,
  gitActions,
  reviewComments,
  showReviewModal,
  onOpenReview,
  onCloseReview,
  t,
}: {
  status: GitStatusInfo;
  projectId: string;
  isWideScreen: boolean;
  sourceControlsFitHeader: boolean;
  supportsProjections: boolean;
  gitActions: GitActionState;
  reviewComments: ReturnType<typeof useProjectReviewComments>;
  showReviewModal: boolean;
  onOpenReview: () => void;
  onCloseReview: () => void;
  t: TranslationFn;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const basePath = useRemoteBasePath();
  const [searchParams, setSearchParams] = useSearchParams();
  const { tab, setTab } = useSourceTab();
  const changedFileCount = countChangedPaths(status);
  const blameFile = searchParams.get("bf") ?? undefined;
  const commitSha = searchParams.get("rev") ?? undefined;
  const worktreeFile = searchParams.get("worktreeFile") ?? undefined;
  const historyOpen =
    tab === "changes" &&
    (searchParams.get("history") === "1" ||
      searchParams.get("tab") === "commits" ||
      commitSha !== undefined);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(false);
  const [showProjectionNotice, setShowProjectionNotice] = useState(false);
  const projectionNoticeNeedsPortal = useMediaQuery("(max-width: 600px)");
  const activeIgnoreWhitespace =
    supportsProjections && ignoreWhitespace;
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
  const handleBrowseHistory = useCallback(() => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev);
        params.delete("tab");
        params.delete("rev");
        params.set("history", "1");
        return params;
      },
      { state: location.state },
    );
  }, [location.state, setSearchParams]);
  return (
    <div className="git-status">
      <div className="source-control-toolbar">
        {!sourceControlsFitHeader && (
          <div className="source-control-mobile-tabs">
            <SourceModeTabs
              tab={tab}
              tabs={SOURCE_TABS}
              variant="stacked"
              counts={{
                changes: changedFileCount,
                comments: reviewComments.pending.length,
              }}
              onSelect={setTab}
              t={t}
            />
          </div>
        )}
        <div className="source-control-action-row">
          <SourceHeaderControls
            gitActions={gitActions}
            pendingCount={reviewComments.pending.length}
            onReview={() => {
              if (reviewComments.pending.length > 0) onOpenReview();
              else setTab("comments");
            }}
            t={t}
          />
        </div>
      </div>

      <GitActionNotices gitActions={gitActions} t={t} />
      {projectionNotice &&
        (projectionNoticeNeedsPortal
          ? createPortal(projectionNotice, document.body)
          : projectionNotice)}

      {tab === "changes" && !historyOpen ? (
        <WorkingTreeBrowser
          projectId={projectId}
          status={status}
          isWideScreen={isWideScreen}
          initialWorkingTreePath={worktreeFile}
          onBrowseHistory={handleBrowseHistory}
          onBlameFile={handleBlameFile}
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
          initialSha={commitSha}
          onBlameFile={handleBlameFile}
          supportsProjections={supportsProjections}
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
      ) : tab === "files" ? (
        <BlameBrowser
          projectId={projectId}
          isWideScreen={isWideScreen}
          initialPath={blameFile}
          onOpenCommit={handleOpenCommit}
          t={t}
        />
      ) : null}

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
