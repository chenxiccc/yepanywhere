import type {
  GitFileChange,
  GitIntegrationOptionReason,
  GitIntegrationOptionsResult,
  GitPullResult,
  GitPushResult,
  GitRemoteCheckResult,
  GitRecentCommit,
  GitStatusInfo,
  GitUntrackedFolderInfo,
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
import { api } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { Modal } from "../components/ui/Modal";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useGitStatus } from "../hooks/useGitStatus";
import { useProject, useProjects } from "../hooks/useProjects";
import { useProjectReviewComments } from "../hooks/useProjectReviewComments";
import { useRelativeNow } from "../hooks/useRelativeNow";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { BlameBrowser } from "./BlameBrowser";
import { CommitBrowser } from "./CommitBrowser";
import { RepoStatusBar } from "./RepoStatusBar";
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
  invalidateRouteRetention,
  patchRouteRetention,
  readRouteRetention,
  subscribeRouteRetention,
  type RouteRetentionKeyInput,
} from "../lib/routeRetention";
import {
  GitDiffModal,
  GitDiffPreview,
  type GitDiffViewState,
} from "./GitStatusDiffPreview";

interface SourceControlRouteState {
  selectedFileKey?: string | null;
  statusRevision?: string | null;
  pageScrollTop?: number;
  diffScrollTopByFileKey?: Record<string, number>;
  diffViewByFileKey?: Record<string, GitDiffViewState>;
}

const SOURCE_CONTROL_ROUTE_TTL_MS = 5 * 60 * 1000;

/** Source-control modes with a built body (topic: source-review-to-session). */
const SOURCE_TABS: readonly SourceTab[] = ["changes", "commits", "files"];

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
  const routeRetentionKey = useMemo(
    () =>
      effectiveProjectId
        ? getSourceControlRouteRetentionKey(sourceKey, effectiveProjectId)
        : null,
    [effectiveProjectId, sourceKey],
  );
  const retainedRouteState = useSourceControlRouteState(routeRetentionKey);

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
              routeRetentionKey={routeRetentionKey}
              retainedRouteState={retainedRouteState}
              supportsRemoteCheck={supportsRemoteCheck}
              supportsPull={supportsPull}
              supportsPush={supportsPush}
              supportsIntegrationOptions={supportsIntegrationOptions}
              onRefreshStatus={refetch}
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
  routeRetentionKey,
  retainedRouteState,
  supportsRemoteCheck,
  supportsPull,
  supportsPush,
  supportsIntegrationOptions,
  onRefreshStatus,
  t,
}: {
  status: GitStatusInfo;
  projectId: string;
  projectName?: string;
  isWideScreen: boolean;
  routeRetentionKey: RouteRetentionKeyInput | null;
  retainedRouteState: SourceControlRouteState | null;
  supportsRemoteCheck: boolean;
  supportsPull: boolean;
  supportsPush: boolean;
  supportsIntegrationOptions: boolean;
  onRefreshStatus: () => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const navigate = useNavigate();
  const basePath = useRemoteBasePath();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab");
  const tab: SourceTab =
    tabParam === "commits"
      ? "commits"
      : tabParam === "files"
        ? "files"
        : "changes";
  const setTab = useCallback(
    (next: SourceTab) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          if (next === "changes") params.delete("tab");
          else params.set("tab", next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
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
  const reviewComments = useProjectReviewComments(projectId);
  const [showReviewModal, setShowReviewModal] = useState(false);
  const [selectedFileKey, setSelectedFileKey] = useState<string | null>(
    () => retainedRouteState?.selectedFileKey ?? null,
  );
  const [expandedUntrackedFolder, setExpandedUntrackedFolder] =
    useState<GitFileChange | null>(null);
  const [untrackedFolderCache, setUntrackedFolderCache] = useState<
    Record<string, GitUntrackedFolderInfo>
  >({});
  const [remoteCheckResult, setRemoteCheckResult] =
    useState<GitRemoteCheckResult | null>(null);
  const [isCheckingRemote, setIsCheckingRemote] = useState(false);
  const [remoteCheckError, setRemoteCheckError] = useState<string | null>(null);
  const [pullResult, setPullResult] = useState<GitPullResult | null>(null);
  const [isPulling, setIsPulling] = useState(false);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pushResult, setPushResult] = useState<GitPushResult | null>(null);
  const [isPushing, setIsPushing] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [integrationOptions, setIntegrationOptions] =
    useState<GitIntegrationOptionsResult | null>(null);
  const [isLoadingIntegrationOptions, setIsLoadingIntegrationOptions] =
    useState(false);
  const [integrationOptionsError, setIntegrationOptionsError] = useState<
    string | null
  >(null);
  const nowMs = useRelativeNow();

  const {
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    allFiles,
    previewableFiles,
  } = useMemo(() => {
    const staged = status.files.filter((f) => f.staged);
    const unstaged = status.files.filter((f) => !f.staged && f.status !== "?");
    const untracked = status.files.filter((f) => f.status === "?");
    const all = [...staged, ...unstaged, ...untracked];
    return {
      stagedFiles: staged,
      unstagedFiles: unstaged,
      untrackedFiles: untracked,
      allFiles: all,
      previewableFiles: all.filter((file) => !isUntrackedFolder(file)),
    };
  }, [status.files]);
  const selectedFile = useMemo(
    () =>
      selectedFileKey
        ? (previewableFiles.find(
            (file) => gitFileKey(file) === selectedFileKey,
          ) ?? null)
        : null,
    [previewableFiles, selectedFileKey],
  );
  const selectedPreviewFileKey = selectedFile ? gitFileKey(selectedFile) : null;
  const retainedSelectedDiffScrollTop = selectedPreviewFileKey
    ? retainedRouteState?.diffScrollTopByFileKey?.[selectedPreviewFileKey]
    : undefined;
  const retainedSelectedDiffView = selectedPreviewFileKey
    ? retainedRouteState?.diffViewByFileKey?.[selectedPreviewFileKey]
    : undefined;
  const statusRevision = useMemo(() => getGitStatusRevision(status), [status]);
  const previousStatusRevisionRef = useRef(statusRevision);

  useEffect(() => {
    if (previousStatusRevisionRef.current === statusRevision) {
      return;
    }
    previousStatusRevisionRef.current = statusRevision;
    setUntrackedFolderCache({});
    setExpandedUntrackedFolder(null);
  }, [statusRevision]);

  const handleUntrackedFolderLoaded = useCallback(
    (info: GitUntrackedFolderInfo) => {
      setUntrackedFolderCache((current) => ({
        ...current,
        [info.path]: info,
      }));
    },
    [],
  );

  const retainSelectedFileKey = useCallback(
    (nextSelectedFileKey: string | null) => {
      if (!routeRetentionKey) {
        return;
      }
      updateSourceControlRouteState(routeRetentionKey, (current) => ({
        ...current,
        selectedFileKey: nextSelectedFileKey,
        statusRevision,
      }));
    },
    [routeRetentionKey, statusRevision],
  );

  const retainDiffScrollTop = useCallback(
    (fileKey: string, scrollTop: number) => {
      if (!routeRetentionKey) {
        return;
      }
      updateSourceControlRouteState(routeRetentionKey, (current) => ({
        ...current,
        diffScrollTopByFileKey: {
          ...current.diffScrollTopByFileKey,
          [fileKey]: scrollTop,
        },
      }));
    },
    [routeRetentionKey],
  );

  const retainDiffView = useCallback(
    (fileKey: string, view: GitDiffViewState) => {
      if (!routeRetentionKey) {
        return;
      }
      updateSourceControlRouteState(routeRetentionKey, (current) => ({
        ...current,
        diffViewByFileKey: {
          ...current.diffViewByFileKey,
          [fileKey]: {
            ...current.diffViewByFileKey?.[fileKey],
            ...view,
          },
        },
      }));
    },
    [routeRetentionKey],
  );

  const handleFileClick = useCallback(
    (file: GitFileChange) => {
      if (isUntrackedFolder(file)) {
        setExpandedUntrackedFolder(file);
        return;
      }

      const nextSelectedFileKey = gitFileKey(file);
      setSelectedFileKey(nextSelectedFileKey);
      retainSelectedFileKey(nextSelectedFileKey);
    },
    [retainSelectedFileKey],
  );

  useEffect(() => {
    const nextSelectedFileKey =
      allFiles.length === 0
        ? null
        : selectedFileKey &&
            previewableFiles.some(
              (file) => gitFileKey(file) === selectedFileKey,
            )
          ? selectedFileKey
          : isWideScreen && previewableFiles[0]
            ? gitFileKey(previewableFiles[0])
            : null;

    if (nextSelectedFileKey !== selectedFileKey) {
      setSelectedFileKey(nextSelectedFileKey);
      retainSelectedFileKey(nextSelectedFileKey);
    }
  }, [
    allFiles.length,
    previewableFiles,
    isWideScreen,
    retainSelectedFileKey,
    selectedFileKey,
  ]);

  useEffect(() => {
    if (!routeRetentionKey) {
      return;
    }
    updateSourceControlRouteState(routeRetentionKey, (current) => ({
      ...current,
      statusRevision,
    }));
  }, [routeRetentionKey, statusRevision]);

  useEffect(() => {
    void projectId;
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setIsCheckingRemote(false);
    setPullResult(null);
    setPullError(null);
    setIsPulling(false);
    setPushResult(null);
    setPushError(null);
    setIsPushing(false);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    setIsLoadingIntegrationOptions(false);
  }, [projectId]);

  const isGitActionRunning = isCheckingRemote || isPulling || isPushing;
  const divergedActionStatus = getDivergedActionStatus(pullResult, pushResult);
  const divergedActionKey = divergedActionStatus
    ? `${divergedActionStatus.ahead}:${divergedActionStatus.behind}:${divergedActionStatus.upstream ?? ""}`
    : "";

  useEffect(() => {
    if (!supportsIntegrationOptions || !divergedActionKey) {
      setIntegrationOptions(null);
      setIntegrationOptionsError(null);
      setIsLoadingIntegrationOptions(false);
      return;
    }

    let cancelled = false;
    setIsLoadingIntegrationOptions(true);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);

    api
      .getGitIntegrationOptions(projectId)
      .then((result) => {
        if (!cancelled) {
          setIntegrationOptions(result);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setIntegrationOptionsError(
            err instanceof Error
              ? err.message
              : t("gitStatusAutoOptionsFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setIsLoadingIntegrationOptions(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [divergedActionKey, projectId, supportsIntegrationOptions, t]);

  const handleCheckRemote = useCallback(async () => {
    if (!supportsRemoteCheck || isGitActionRunning) return;

    setIsCheckingRemote(true);
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setPullResult(null);
    setPullError(null);
    setPushResult(null);
    setPushError(null);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    try {
      const result = await api.checkGitRemote(projectId);
      setRemoteCheckResult(result);
      if (result.status === "checked") {
        await onRefreshStatus();
      }
    } catch (err) {
      setRemoteCheckError(
        err instanceof Error ? err.message : t("gitStatusRemoteCheckFailed"),
      );
    } finally {
      setIsCheckingRemote(false);
    }
  }, [isGitActionRunning, onRefreshStatus, projectId, supportsRemoteCheck, t]);

  const handlePull = useCallback(async () => {
    if (!supportsPull || isGitActionRunning) return;

    setIsPulling(true);
    setPullResult(null);
    setPullError(null);
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setPushResult(null);
    setPushError(null);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    try {
      const result = await api.pullGit(projectId);
      setPullResult(result);
      if (result.status === "pulled") {
        if (routeRetentionKey) {
          invalidateRouteRetention(routeRetentionKey);
        }
        await onRefreshStatus();
      }
    } catch (err) {
      setPullError(
        err instanceof Error ? err.message : t("gitStatusPullFailed"),
      );
    } finally {
      setIsPulling(false);
    }
  }, [
    isGitActionRunning,
    onRefreshStatus,
    projectId,
    routeRetentionKey,
    supportsPull,
    t,
  ]);

  const handlePush = useCallback(async () => {
    if (!supportsPush || isGitActionRunning) return;

    setIsPushing(true);
    setPushResult(null);
    setPushError(null);
    setRemoteCheckResult(null);
    setRemoteCheckError(null);
    setPullResult(null);
    setPullError(null);
    setIntegrationOptions(null);
    setIntegrationOptionsError(null);
    try {
      const result = await api.pushGit(projectId);
      setPushResult(result);
      if (
        result.status === "pushed" ||
        result.status === "published" ||
        result.status === "up-to-date"
      ) {
        if (routeRetentionKey) {
          invalidateRouteRetention(routeRetentionKey);
        }
        await onRefreshStatus();
      }
    } catch (err) {
      setPushError(
        err instanceof Error ? err.message : t("gitStatusPushFailed"),
      );
    } finally {
      setIsPushing(false);
    }
  }, [
    isGitActionRunning,
    onRefreshStatus,
    projectId,
    routeRetentionKey,
    supportsPush,
    t,
  ]);

  const checkedRemoteAt =
    pushResult?.checkedRemoteAt ??
    pullResult?.checkedRemoteAt ??
    remoteCheckResult?.checkedRemoteAt ??
    status.checkedRemoteAt ??
    null;
  const gitActionMessage = getGitActionMessage({
    remoteCheckResult,
    remoteCheckError,
    pullResult,
    pullError,
    pushResult,
    pushError,
    t,
  });
  const gitActionMessageClass = getGitActionMessageClass({
    remoteCheckResult,
    remoteCheckError,
    pullResult,
    pullError,
    pushResult,
    pushError,
  });

  return (
    <div className="git-status">
      <RepoStatusBar
        repoName={projectName}
        status={status}
        tabs={
          <SourceModeTabs
            tab={tab}
            tabs={SOURCE_TABS}
            onSelect={setTab}
            t={t}
          />
        }
        actions={
          reviewComments.pending.length > 0 && (
            <button
              type="button"
              className="git-status-action-button review-tray-button"
              onClick={() => setShowReviewModal(true)}
            >
              {t("sourceReviewReview", {
                count: reviewComments.pending.length,
              })}
            </button>
          )
        }
        t={t}
      />

      {tab === "commits" ? (
        <CommitBrowser
          projectId={projectId}
          isWideScreen={isWideScreen}
          onBlameFile={handleBlameFile}
          t={t}
        />
      ) : tab === "files" ? (
        <BlameBrowser
          projectId={projectId}
          isWideScreen={isWideScreen}
          initialPath={blameFile}
          t={t}
        />
      ) : (
        <>
          <div className="git-status-workspace">
            <div className="git-status-left-pane">
              <div className="git-status-branch">
                <span className="git-branch-icon">
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                </span>
                <span className="git-branch-name">
                  {status.branch ?? t("gitStatusDetachedHead")}
                </span>
                {status.upstream && (
                  <span className="git-upstream"> → {status.upstream}</span>
                )}
                {(status.ahead > 0 || status.behind > 0) && (
                  <span className="git-ahead-behind">
                    {status.ahead > 0 && ` ↑${status.ahead}`}
                    {status.behind > 0 && ` ↓${status.behind}`}
                  </span>
                )}
                <span className="git-remote-check-time">
                  {t("gitStatusLastCheckedRemote", {
                    time: formatRemoteCheckTime(checkedRemoteAt, nowMs, t),
                  })}
                </span>
                <span
                  className={`git-clean-badge ${status.isClean ? "git-clean" : "git-dirty"}`}
                >
                  {status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
                </span>
                {(supportsPull || supportsPush || supportsRemoteCheck) && (
                  <div className="git-status-actions">
                    {supportsPull && (
                      <button
                        type="button"
                        className="git-status-action-button"
                        onClick={handlePull}
                        disabled={isGitActionRunning}
                      >
                        {isPulling ? t("gitStatusPulling") : t("gitStatusPull")}
                      </button>
                    )}
                    {supportsPush && (
                      <button
                        type="button"
                        className="git-status-action-button"
                        onClick={handlePush}
                        disabled={isGitActionRunning}
                      >
                        {isPushing ? t("gitStatusPushing") : t("gitStatusPush")}
                      </button>
                    )}
                    {supportsRemoteCheck && (
                      <button
                        type="button"
                        className="git-status-action-button"
                        onClick={handleCheckRemote}
                        disabled={isGitActionRunning}
                      >
                        {isCheckingRemote
                          ? t("gitStatusCheckingRemote")
                          : t("gitStatusCheckRemote")}
                      </button>
                    )}
                  </div>
                )}
              </div>

              {gitActionMessage && (
                <div
                  className={`git-status-action-message ${gitActionMessageClass}`}
                >
                  {gitActionMessage}
                </div>
              )}
              {divergedActionStatus && supportsIntegrationOptions && (
                <GitIntegrationOptionsPanel
                  options={integrationOptions}
                  loading={isLoadingIntegrationOptions}
                  error={integrationOptionsError}
                  t={t}
                />
              )}

              <div className="git-status-file-pane">
                {status.isClean ? (
                  <div className="git-status-empty">
                    {t("gitStatusWorkingTreeClean")}
                  </div>
                ) : (
                  <>
                    {stagedFiles.length > 0 && (
                      <GitFileSection
                        title={t("gitStatusStaged")}
                        files={stagedFiles}
                        selectedFile={selectedFile}
                        onFileClick={handleFileClick}
                      />
                    )}
                    {unstagedFiles.length > 0 && (
                      <GitFileSection
                        title={t("gitStatusChanges")}
                        files={unstagedFiles}
                        selectedFile={selectedFile}
                        onFileClick={handleFileClick}
                      />
                    )}
                    {untrackedFiles.length > 0 && (
                      <GitFileSection
                        title={t("gitStatusUntracked")}
                        files={untrackedFiles}
                        selectedFile={selectedFile}
                        onFileClick={handleFileClick}
                      />
                    )}
                  </>
                )}
              </div>

              <GitRecentCommits commits={status.recentCommits ?? []} t={t} />
            </div>

            {isWideScreen && !status.isClean && (
              <GitDiffPreview
                file={selectedFile}
                fileKey={selectedPreviewFileKey}
                projectId={projectId}
                retainedScrollTop={retainedSelectedDiffScrollTop}
                retainedDiffView={retainedSelectedDiffView}
                onRetainScrollTop={retainDiffScrollTop}
                onRetainDiffView={retainDiffView}
                t={t}
              />
            )}
          </div>

          {!isWideScreen && selectedFile && (
            <GitDiffModal
              file={selectedFile}
              fileKey={selectedPreviewFileKey ?? gitFileKey(selectedFile)}
              projectId={projectId}
              retainedDiffView={retainedSelectedDiffView}
              onRetainDiffView={retainDiffView}
              t={t}
              onClose={() => {
                setSelectedFileKey(null);
                retainSelectedFileKey(null);
              }}
            />
          )}
        </>
      )}

      {showReviewModal && (
        <ReviewSubmitModal
          projectId={projectId}
          recentReviewSessionId={reviewComments.recentReviewSessionId}
          onClose={() => setShowReviewModal(false)}
          onNavigateSession={(sessionId) =>
            navigate(`${basePath}/projects/${projectId}/sessions/${sessionId}`)
          }
          t={t}
        />
      )}

      {expandedUntrackedFolder && (
        <UntrackedFolderModal
          folder={expandedUntrackedFolder}
          projectId={projectId}
          cachedInfo={
            untrackedFolderCache[expandedUntrackedFolder.path] ?? null
          }
          onLoaded={handleUntrackedFolderLoaded}
          onClose={() => setExpandedUntrackedFolder(null)}
          t={t}
        />
      )}
    </div>
  );
}

function GitFileSection({
  title,
  files,
  selectedFile,
  onFileClick,
}: {
  title: string;
  files: GitFileChange[];
  selectedFile: GitFileChange | null;
  onFileClick: (file: GitFileChange) => void;
}) {
  return (
    <div className="git-file-section">
      <h3 className="git-file-section-title">
        {title} <span className="git-file-count">({files.length})</span>
      </h3>
      <ul className="git-file-list">
        {files.map((file) => (
          <GitFileItem
            key={`${file.path}-${file.staged}`}
            file={file}
            isSelected={
              selectedFile
                ? gitFileKey(file) === gitFileKey(selectedFile)
                : false
            }
            onClick={onFileClick}
          />
        ))}
      </ul>
    </div>
  );
}

function GitFileItem({
  file,
  isSelected,
  onClick,
}: {
  file: GitFileChange;
  isSelected: boolean;
  onClick: (file: GitFileChange) => void;
}) {
  return (
    <li className="git-file-list-row">
      <button
        type="button"
        className={`git-file-item git-file-item-clickable ${isSelected ? "git-file-item-selected" : ""}`}
        onClick={() => onClick(file)}
        aria-current={isSelected ? "true" : undefined}
      >
        <span
          className={`git-status-badge git-status-${file.status.toLowerCase()}`}
        >
          {file.status}
        </span>
        <span className="git-file-path">
          {file.origPath ? (
            <>
              {file.origPath} → {file.path}
            </>
          ) : (
            file.path
          )}
        </span>
        {(file.linesAdded !== null || file.linesDeleted !== null) && (
          <span className="git-line-counts">
            {file.linesAdded !== null && (
              <span className="git-lines-added">+{file.linesAdded}</span>
            )}
            {file.linesDeleted !== null && (
              <span className="git-lines-deleted">-{file.linesDeleted}</span>
            )}
          </span>
        )}
      </button>
    </li>
  );
}

function GitRecentCommits({
  commits,
  t,
}: {
  commits: GitRecentCommit[];
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  return (
    <section className="git-recent-commits" aria-labelledby="git-recent-title">
      <h3 id="git-recent-title" className="git-recent-title">
        {t("gitStatusRecentCommits")}
      </h3>
      {commits.length === 0 ? (
        <div className="git-recent-empty">{t("gitStatusNoRecentCommits")}</div>
      ) : (
        <ol className="git-recent-list">
          {commits.map((commit) => (
            <li key={commit.hash} className="git-recent-item">
              <span className="git-recent-subject">
                {commit.subject || t("gitStatusUntitledCommit")}
              </span>
              <span className="git-recent-meta">
                <span className="git-recent-hash">{commit.shortHash}</span>
                <span className="git-recent-author">{commit.authorName}</span>
                <time
                  dateTime={commit.authorDate}
                  title={formatCommitDateTime(commit.authorDate)}
                >
                  {formatCommitDate(commit.authorDate)}
                </time>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function UntrackedFolderModal({
  folder,
  projectId,
  cachedInfo,
  onLoaded,
  t,
  onClose,
}: {
  folder: GitFileChange;
  projectId: string;
  cachedInfo: GitUntrackedFolderInfo | null;
  onLoaded: (info: GitUntrackedFolderInfo) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  onClose: () => void;
}) {
  const [info, setInfo] = useState<GitUntrackedFolderInfo | null>(cachedInfo);
  const [loading, setLoading] = useState(!cachedInfo);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (cachedInfo) {
      setInfo(cachedInfo);
      setLoading(false);
      setError(null);
      return;
    }

    let cancelled = false;
    setInfo(null);
    setLoading(true);
    setError(null);

    api
      .getGitUntrackedFolder(projectId, folder.path)
      .then((result) => {
        if (cancelled) return;
        setInfo(result);
        onLoaded(result);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(
            err instanceof Error
              ? err.message
              : t("gitStatusLoadUntrackedFolderFailed"),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [cachedInfo, folder.path, onLoaded, projectId, t]);

  return (
    <Modal title={folder.path} onClose={onClose}>
      <div className="git-untracked-folder-modal">
        {loading && (
          <div className="git-untracked-folder-status">
            {t("gitStatusLoading")}
          </div>
        )}
        {!loading && error && (
          <div className="git-untracked-folder-status git-untracked-folder-error">
            {error}
          </div>
        )}
        {!loading && !error && info && (
          <>
            <div className="git-untracked-folder-summary">
              {info.truncated
                ? t("gitStatusUntrackedFolderCountTruncated", {
                    count: info.files.length,
                  })
                : t("gitStatusUntrackedFolderCount", {
                    count: info.files.length,
                  })}
            </div>
            {info.files.length === 0 ? (
              <div className="git-untracked-folder-status">
                {t("gitStatusUntrackedFolderEmpty")}
              </div>
            ) : (
              <ul className="git-untracked-folder-list">
                {info.files.map((path) => (
                  <li key={path} className="git-untracked-folder-item">
                    <span className="git-status-badge git-status-?">?</span>
                    <span className="git-file-path">{path}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function gitFileKey(file: GitFileChange): string {
  return `${file.path}\0${file.staged ? "1" : "0"}\0${file.status}`;
}

function isUntrackedFolder(file: GitFileChange): boolean {
  return file.status === "?" && !file.staged && file.path.endsWith("/");
}

function getGitStatusRevision(status: GitStatusInfo): string {
  return JSON.stringify({
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    clean: status.isClean,
    files: status.files.map(gitFileKey),
    recent: (status.recentCommits ?? []).map((commit) => commit.hash),
    checkedRemoteAt: status.checkedRemoteAt ?? null,
  });
}

function formatCommitDate(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

function formatCommitDateTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }
  return new Date(timestamp).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function formatRemoteCheckTime(
  value: string | null,
  nowMs: number,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  if (!value) {
    return t("gitStatusRemoteUnknown");
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return value;
  }

  const elapsedMs = Math.max(0, nowMs - timestamp);
  const minuteMs = 60 * 1000;
  const hourMs = 60 * minuteMs;
  const dayMs = 24 * hourMs;

  if (elapsedMs < minuteMs) {
    return t("gitStatusRemoteJustNow");
  }
  if (elapsedMs < hourMs) {
    return t("gitStatusRemoteMinutesAgo", {
      count: Math.floor(elapsedMs / minuteMs),
    });
  }
  if (elapsedMs < dayMs) {
    return t("gitStatusRemoteHoursAgo", {
      count: Math.floor(elapsedMs / hourMs),
    });
  }
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getRemoteCheckMessage(
  result: GitRemoteCheckResult | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (result?.status) {
    case "checked":
      return t("gitStatusRemoteCheckSuccess");
    case "busy":
      return t("gitStatusRemoteCheckBusy");
    case "not-a-git-repo":
      return t("gitStatusRemoteCheckNotRepo");
    case "failed":
      return t("gitStatusRemoteCheckFailed");
    default:
      return "";
  }
}

function getPullMessage(
  result: GitPullResult | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (result?.status) {
    case "pulled":
      return t("gitStatusPullSuccess");
    case "busy":
      return t("gitStatusPullBusy");
    case "not-a-git-repo":
      return t("gitStatusPullNotRepo");
    case "failed":
      if (isDivergedStatus(result.gitStatus)) {
        return t("gitStatusPullDiverged", {
          ahead: result.gitStatus.ahead,
          behind: result.gitStatus.behind,
        });
      }
      return t("gitStatusPullFailed");
    default:
      return "";
  }
}

function getPushMessage(
  result: GitPushResult | null,
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (result?.status) {
    case "pushed":
      return t("gitStatusPushSuccess");
    case "published":
      return t("gitStatusPushPublished");
    case "up-to-date":
      return t("gitStatusPushAlreadyUpToDate");
    case "busy":
      return t("gitStatusPushBusy");
    case "no-upstream":
      return t("gitStatusPushNoUpstream");
    case "rejected":
      if (isDivergedStatus(result.gitStatus)) {
        return t("gitStatusPushDiverged", {
          ahead: result.gitStatus.ahead,
          behind: result.gitStatus.behind,
        });
      }
      return t("gitStatusPushRejected");
    case "not-a-git-repo":
      return t("gitStatusPushNotRepo");
    case "failed":
      return t("gitStatusPushFailed");
    default:
      return "";
  }
}

function isDivergedStatus(
  status: GitPullResult["gitStatus"] | GitPushResult["gitStatus"],
): status is GitStatusInfo {
  return Boolean(status && status.ahead > 0 && status.behind > 0);
}

function getDivergedActionStatus(
  pullResult: GitPullResult | null,
  pushResult: GitPushResult | null,
): GitStatusInfo | null {
  if (
    pullResult?.status === "failed" &&
    isDivergedStatus(pullResult.gitStatus)
  ) {
    return pullResult.gitStatus;
  }
  if (
    pushResult?.status === "rejected" &&
    isDivergedStatus(pushResult.gitStatus)
  ) {
    return pushResult.gitStatus;
  }
  return null;
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

function getGitActionMessage({
  remoteCheckResult,
  remoteCheckError,
  pullResult,
  pullError,
  pushResult,
  pushError,
  t,
}: {
  remoteCheckResult: GitRemoteCheckResult | null;
  remoteCheckError: string | null;
  pullResult: GitPullResult | null;
  pullError: string | null;
  pushResult: GitPushResult | null;
  pushError: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
}): string {
  if (remoteCheckError) {
    return remoteCheckError;
  }
  if (pullError) {
    return pullError;
  }
  if (pushError) {
    return pushError;
  }
  if (remoteCheckResult) {
    return getRemoteCheckMessage(remoteCheckResult, t);
  }
  if (pullResult) {
    return getPullMessage(pullResult, t);
  }
  if (pushResult) {
    return getPushMessage(pushResult, t);
  }
  return "";
}

function getGitActionMessageClass({
  remoteCheckResult,
  remoteCheckError,
  pullResult,
  pullError,
  pushResult,
  pushError,
}: {
  remoteCheckResult: GitRemoteCheckResult | null;
  remoteCheckError: string | null;
  pullResult: GitPullResult | null;
  pullError: string | null;
  pushResult: GitPushResult | null;
  pushError: string | null;
}): string {
  if (
    remoteCheckResult?.status === "checked" ||
    pullResult?.status === "pulled" ||
    pushResult?.status === "pushed" ||
    pushResult?.status === "published" ||
    pushResult?.status === "up-to-date"
  ) {
    return "git-status-action-message-success";
  }
  if (
    remoteCheckResult ||
    remoteCheckError ||
    pullResult ||
    pullError ||
    pushResult ||
    pushError
  ) {
    return "git-status-action-message-warning";
  }
  return "";
}
