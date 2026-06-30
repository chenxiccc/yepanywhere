import type {
  GitFileChange,
  GitHistoryCommitDetail,
  GitHistoryCommitSummary,
  GitStashDetail,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api } from "../api/client";
import { GitBranchMergeModal } from "../components/GitBranchMergeModal";
import { GitBranchCreateModal } from "../components/GitBranchCreateModal";
import { GitBranchSwitchModal } from "../components/GitBranchSwitchModal";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { GitCommitHistoryPane } from "../components/git-status/GitCommitHistoryPane";
import { GitConfirmationModal } from "../components/git-status/GitConfirmationModal";
import { GitPreviewPane } from "../components/git-status/GitPreviewPane";
import { GitStashPane } from "../components/git-status/GitStashPane";
import { GitStatusSidebar } from "../components/git-status/GitStatusSidebar";
import { GitStatusSummaryBar } from "../components/git-status/GitStatusSummaryBar";
import { FilePathTitle } from "../components/git-status/utils";
import { FileViewer } from "../components/FileViewer";
import { Button } from "../components/ui/Button";
import { Modal } from "../components/ui/Modal";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useSourceManagerStatus } from "../hooks/useSourceManagerStatus";
import { useGitStatusActions } from "../hooks/useGitStatusActions";
import { useGitStatusSelection } from "../hooks/useGitStatusSelection";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProject, useProjects } from "../hooks/useProjects";
import { useI18n } from "../i18n";
import { BROWSER_LOCAL_KEYS } from "../lib/storageKeys";
import "../styles/source-manager.css";
import { useNavigationLayout } from "../layouts";

// 占位 status：切到未访问过的项目时，真 status 还没回来，先用全空占位让框架
// （四个 tab、顶部栏）渲染出来，避免整页白屏闪烁。isGitRepo 设 true 以走框架分支，
// 真 status 回来后若 isGitRepo=false 再切换到“非 git 仓库”提示。
// Placeholder status: when switching to a never-visited project, real status isn't
// back yet — use an all-empty placeholder so the framework (four tabs, top bar)
// renders instead of a full-page white flash. isGitRepo=true so the framework branch
// is taken; if real status comes back with isGitRepo=false, we switch to the
// "not a git repo" prompt.
const PLACEHOLDER_STATUS: import("@yep-anywhere/shared").SourceManagerStatusInfo = {
  isGitRepo: true,
  branch: null,
  upstream: null,
  remote: null,
  ahead: 0,
  behind: 0,
  isClean: true,
  latestLocalCommit: null,
  stashes: [],
  files: [],
};

export function SourceManagerPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const branchParam = searchParams.get("branch");
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const { projects, loading: projectsLoading } = useProjects();
  // 侧边栏入口（无 ?projectId）优先恢复上次在源码管理页停留的项目（校验仍存在），
  // 再 fallback 到 projects[0]（lastActivity 最新）。
  // Sidebar entry (no ?projectId): prefer last viewed project in git-status (validated to exist),
  // then fallback to projects[0] (most recent by lastActivity).
  const lastViewedProject = localStorage.getItem(
    BROWSER_LOCAL_KEYS.lastViewedProjectGit,
  );
  const lastProjectValid =
    !!lastViewedProject &&
    projects.some((project) => project.id === lastViewedProject);
  const effectiveProjectId =
    projectId ||
    (lastProjectValid ? lastViewedProject : undefined) ||
    projects[0]?.id;
  const { project } = useProject(effectiveProjectId);
  const { gitStatus, loading, error, refetch, applyStatus } =
    useSourceManagerStatus(effectiveProjectId);

  useDocumentTitle(project?.name, t("gitStatusTitle"));

  // 停留项目持久化：解析出有效项目后写入，下次侧边栏进入恢复 / Persist viewed project
  useEffect(() => {
    if (effectiveProjectId) {
      localStorage.setItem(
        BROWSER_LOCAL_KEYS.lastViewedProjectGit,
        effectiveProjectId,
      );
    }
  }, [effectiveProjectId]);

  const handleProjectChange = (newProjectId: string) => {
    localStorage.setItem(
      BROWSER_LOCAL_KEYS.lastViewedProjectGit,
      newProjectId,
    );
    setSearchParams({ projectId: newProjectId }, { replace: true });
  };

  if (!effectiveProjectId && !projectsLoading && projects.length === 0) {
    return <div className="error">{t("gitStatusNoProjects")}</div>;
  }

  const wrapperClass = isWideScreen
    ? "main-content-wrapper"
    : "main-content-mobile";
  const innerClass = isWideScreen
    ? "main-content-full"
    : "main-content-mobile-inner";

  return (
    <div className={wrapperClass}>
      <div className={innerClass}>
        <PageHeader
          title=""
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

        <main className="page-scroll-container git-status-page-scroll">
          <div className="page-content-inner git-status-page-content">
            {error ? (
              <div className="error">
                {t("gitStatusErrorPrefix")} {error.message}
              </div>
            ) : gitStatus && !gitStatus.isGitRepo ? (
              // 非 git 仓库：保留提示，不显示框架 / Not a git repo: keep prompt, no framework
              <div className="git-status-empty">{t("gitStatusNotRepo")}</div>
            ) : effectiveProjectId ? (
              // 有项目即渲染框架：真 status 没回来时用占位 status，避免整页白屏
              // Render framework as long as there's a project: use placeholder status
              // while real status hasn't arrived, avoiding a full-page white flash
              <GitStatusContent
                status={gitStatus ?? PLACEHOLDER_STATUS}
                isLoading={!gitStatus}
                projectId={effectiveProjectId}
                projectPath={project?.path}
                refetch={refetch}
                applyStatus={applyStatus}
                initialViewingBranch={branchParam}
                t={t as never}
              />
            ) : (
              <div className="loading">{t("gitStatusLoading")}</div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}

function GitStatusContent({
  status,
  isLoading,
  projectId,
  refetch,
  applyStatus,
  t,
  projectPath,
  initialViewingBranch,
}: {
  status: import("@yep-anywhere/shared").SourceManagerStatusInfo;
  /** 真 status 尚未到达（占位 status 期间）：顶部隐藏复制按钮/HEAD pill、分支名占位 —，
   *  各 tab 不显示误导性空态文案 / Real status not yet arrived (placeholder period):
   *  top bar hides copy button/HEAD pill, shows — as branch name; tabs hide
   *  misleading empty-state copy. */
  isLoading: boolean;
  projectId: string;
  refetch: () => Promise<void>;
  /** 写端点响应含 status 时直接应用，省掉一次 refetch / Apply write-endpoint
   *  status directly when the response carries one, skipping a refetch. */
  applyStatus: (status: import("@yep-anywhere/shared").SourceManagerStatusInfo) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  projectPath?: string;
  /** 从 URL ?branch= 传入的初始查看分支（仅首次进入生效）/ Initial viewing branch from URL ?branch= (first entry only) */
  initialViewingBranch?: string | null;
}) {
  const isNarrowScreen = useMediaQuery("(max-width: 900px)");
  const isMediumScreen = useMediaQuery("(max-width: 1099px)");

  // 查看分支：null = 跟随当前 checkout 分支 / Viewing branch: null = follow current checkout
  // 初始化优先级：URL ?branch= > localStorage 上次停留 > null（跟随）
  // Init priority: URL ?branch= > localStorage last viewed > null (follow)
  const initialBranchConsumed = useRef(false);
  const [viewingBranch, setViewingBranch] = useState<string | null>(() => {
    if (initialViewingBranch) {
      initialBranchConsumed.current = true;
      return initialViewingBranch;
    }
    if (typeof window !== "undefined") {
      return localStorage.getItem(BROWSER_LOCAL_KEYS.lastViewedBranch);
    }
    return null;
  });
  // 切换项目时重置查看分支为 null：让顶部跟随新项目当前 checkout 分支，
  // 而不是沿用旧项目残留的 viewingBranch（lastViewedBranch 是跨项目共享的全局值）。
  // Reset viewing branch to null on project switch: let the top bar follow the new
  // project's current checkout instead of reusing the stale viewingBranch from the
  // previous project (lastViewedBranch is a global, cross-project value).
  const viewedProjectIdRef = useRef(projectId);
  useEffect(() => {
    if (viewedProjectIdRef.current !== projectId) {
      viewedProjectIdRef.current = projectId;
      setViewingBranch(null);
    }
  }, [projectId]);
  // 派生：history 实际使用的 ref / Derived: the ref history actually uses
  const effectiveViewingBranch =
    viewingBranch ?? status.branch ?? null;
  // 派生：查看的是否为当前已 checkout 分支 / Derived: whether viewing == checked-out
  const isViewingCurrent = effectiveViewingBranch === status.branch;

  // 持久化查看分支 / Persist viewing branch
  useEffect(() => {
    if (initialBranchConsumed.current) {
      // 首次进入若来自 URL 参数，先不覆盖 localStorage（等用户主动切换再写）
      // On first entry from URL param, don't overwrite localStorage yet
      initialBranchConsumed.current = false;
      return;
    }
    if (viewingBranch) {
      localStorage.setItem(
        BROWSER_LOCAL_KEYS.lastViewedBranch,
        viewingBranch,
      );
    }
  }, [viewingBranch]);

  // 仅设查看分支，不 checkout / Set viewing branch only, no checkout
  const handleSelectViewBranch = useCallback((branchName: string) => {
    setViewingBranch(branchName);
  }, []);

  const [activeView, setActiveView] = useState<
    "files" | "changes" | "stashed" | "history"
  >("files");
  const [commitMessage, setCommitMessage] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [fileActionsMenuOpen, setFileActionsMenuOpen] = useState(false);
  /* 文件 tab 相关 / Files tab related */
  const [fileTreeSearchQuery, setFileTreeSearchQuery] = useState("");
  const [fileTreeSelectedPath, setFileTreeSelectedPath] = useState<
    string | null
  >(null);
  const [fileTreeRefreshKey, setFileTreeRefreshKey] = useState(0);
  const [historyCommits, setHistoryCommits] = useState<
    GitHistoryCommitSummary[]
  >([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [createBranchInitialName, setCreateBranchInitialName] = useState("");
  const [activeViewRefreshKey, setActiveViewRefreshKey] = useState(0);
  const [refreshingActiveView, setRefreshingActiveView] = useState<
    "files" | "changes" | "stashed" | "history" | null
  >(null);
  /* 文件重命名 / File rename */
  const [renameFileState, setRenameFileState] = useState<{
    path: string;
    name: string;
  } | null>(null);
  const [renameFileNewName, setRenameFileNewName] = useState("");
  const [renameFileBusy, setRenameFileBusy] = useState(false);
  const [renameFileError, setRenameFileError] = useState<string | null>(null);
  /* 文件删除 / File delete */
  const [deleteFileState, setDeleteFileState] = useState<{
    path: string;
    name: string;
    isDirectory: boolean;
  } | null>(null);
  const [deleteFileBusy, setDeleteFileBusy] = useState(false);
  const [selectedHistoryCommitHash, setSelectedHistoryCommitHash] = useState<
    string | null
  >(null);
  const [historyModalCommit, setHistoryModalCommit] =
    useState<GitHistoryCommitDetail | null>(null);
  const [historyPreviewModal, setHistoryPreviewModal] = useState<{
    file: GitFileChange;
    historyCommit: { hash: string; previousPath?: string };
  } | null>(null);
  const [stashModal, setStashModal] = useState<GitStashDetail | null>(null);
  const [stashPreviewModal, setStashPreviewModal] = useState<{
    file: GitFileChange;
    stashRef: { ref: string; previousPath?: string };
  } | null>(null);
  const [selectedStashRef, setSelectedStashRef] = useState<string | null>(null);

  const {
    excludedCommitFileKeys,
    handleCommitFileToggle,
    handleCommitFilesSelection,
    handleFileClick,
    previewModalFile,
    selectedCommitFiles,
    selectedFile,
    setPreviewModalFile,
  } = useGitStatusSelection(projectId, status.files, isNarrowScreen);

  const normalizedFileFilter = fileFilter.trim().toLowerCase();
  const visibleFiles = useMemo(
    () =>
      [...status.files]
        .sort((a, b) => a.path.localeCompare(b.path))
        .filter((file) => {
          if (normalizedFileFilter.length === 0) return true;
          return [file.path, file.origPath]
            .filter((value): value is string => typeof value === "string")
            .some((value) =>
              value.toLowerCase().includes(normalizedFileFilter),
            );
        }),
    [normalizedFileFilter, status.files],
  );

  const selectedCommitCount = selectedCommitFiles.length;
  const selectedCommitPaths = selectedCommitFiles.map((file) => file.path);
  const canCommit = commitMessage.trim().length > 0 && selectedCommitCount > 0;
  const remoteName = status.remote ?? "origin";
  // history 重载 key：基于查看分支 + 手动刷新，不含 ahead/behind（避免轮询抖动）
  // History reload key: based on viewing branch + manual refresh, no ahead/behind (avoids polling jitter)
  const historyReloadKey = `${effectiveViewingBranch ?? "HEAD"}:${activeViewRefreshKey}`;
  // 手动刷新 key，用于刷新按钮 / Manual refresh key for refresh button
  const historyRefreshKey = historyReloadKey;

  // 分支切换时刷新当前激活的 tab / Refresh active tab when branch changes
  const prevBranchRef = useRef(status.branch);
  useEffect(() => {
    const prevBranch = prevBranchRef.current;
    prevBranchRef.current = status.branch;
    // 首次加载时跳过 / Skip on initial load
    if (prevBranch === undefined || prevBranch === status.branch) return;
    // 分支已切换，触发刷新 / Branch changed, trigger refresh
    if (activeView === "files") {
      setFileTreeRefreshKey((k) => k + 1);
    } else if (activeView === "changes") {
      refetch();
    }
    // history 和 stashed 由 historyReloadKey 自动触发 / history and stashed auto-trigger via historyReloadKey
  }, [status.branch]); // eslint-disable-line react-hooks/exhaustive-deps

  // 手动刷新激活的 tab / Manually refresh the active tab
  const handleRefreshActiveView = useCallback(() => {
    setRefreshingActiveView(activeView);
    // 保持 spinning 至少 2 圈动画（0.8s × 2 = 1.6s）/ Keep spinning for at least 2 rotation cycles
    const minSpinningMs = 1600;
    const finishSpinning = () => {
      setRefreshingActiveView(null);
    };
    const spinningTimer = window.setTimeout(finishSpinning, minSpinningMs);

    if (activeView === "files") {
      setFileTreeRefreshKey((k) => k + 1);
    } else if (activeView === "changes" || activeView === "stashed") {
      refetch().finally(() => {
        // 在最短动画时间后清除 / Clear after minimum animation time
        window.clearTimeout(spinningTimer);
        finishSpinning();
      });
    } else {
      // history：通过改变 refresh key 触发重新加载 / history: trigger reload via refresh key
      setActiveViewRefreshKey((k) => k + 1);
    }
  }, [activeView, refetch]);

  // 重命名文件 / Rename file
  const handleRenameFile = useCallback((path: string, name: string) => {
    setRenameFileState({ path, name });
    setRenameFileNewName(name);
    setRenameFileError(null);
  }, []);

  const handleRenameFileConfirm = useCallback(async () => {
    if (!renameFileState || !renameFileNewName.trim()) return;
    setRenameFileBusy(true);
    setRenameFileError(null);
    try {
      await api.renameFile(projectId, renameFileState.path, renameFileNewName.trim());
      setRenameFileState(null);
      setFileTreeRefreshKey((k) => k + 1);
      // 同时刷新 git status 以更新 Changes tab / Also refresh git status to update Changes tab
      refetch();
    } catch (err) {
      setRenameFileError(
        err instanceof Error ? err.message : t("sourceManagerFileContextActionFailed", { action: "rename" }),
      );
    } finally {
      setRenameFileBusy(false);
    }
  }, [renameFileState, renameFileNewName, projectId, t]);

  // 删除文件 / Delete file
  const handleDeleteFile = useCallback(
    (path: string, name: string, isDirectory: boolean) => {
      setDeleteFileState({ path, name, isDirectory });
    },
    [],
  );

  const handleDeleteFileConfirm = useCallback(async () => {
    if (!deleteFileState) return;
    setDeleteFileBusy(true);
    try {
      await api.deleteFile(projectId, deleteFileState.path);
      setDeleteFileState(null);
      setFileTreeRefreshKey((k) => k + 1);
      // 同时刷新 git status 以更新 Changes tab / Also refresh git status to update Changes tab
      refetch();
    } catch (err) {
      console.error("Failed to delete file:", err);
    } finally {
      setDeleteFileBusy(false);
    }
  }, [deleteFileState, projectId, refetch]);

  useEffect(() => {
    let cancelled = false;

    if (activeView !== "history" || historyRefreshKey.length === 0) return;

    setHistoryLoading(true);
    setHistoryLoadingMore(false);
    setHistoryError(null);
    setHistoryCommits([]);
    setHistoryHasMore(false);
    setHistoryCursor(null);
    setSelectedHistoryCommitHash(null);

    api
      .getGitHistory(projectId, {
        limit: 25,
        branch: effectiveViewingBranch ?? undefined,
      })
      .then((result) => {
        if (cancelled) return;
        setHistoryCommits(result.commits);
        setHistoryHasMore(result.hasMore);
        setHistoryCursor(result.nextCursor);
        setSelectedHistoryCommitHash(null);
        setHistoryLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setHistoryError(
          err instanceof Error ? err.message : t("sourceManagerActionFailed"),
        );
        setHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeView, historyRefreshKey, projectId, effectiveViewingBranch, t]);

  useEffect(() => {
    if (activeView !== "stashed") return;

    if (status.stashes.length === 0) {
      setActiveView("changes");
      setSelectedStashRef(null);
      return;
    }

    setSelectedStashRef((current) => {
      if (status.stashes.length === 0) return null;
      if (isNarrowScreen) {
        return current &&
          status.stashes.some((stash) => stash.ref === current)
          ? current
          : null;
      }
      if (current && status.stashes.some((stash) => stash.ref === current)) {
        return current;
      }
      return status.stashes[0]?.ref ?? null;
    });
  }, [activeView, isNarrowScreen, status.stashes]);

  const handleLoadMoreHistory = async () => {
    if (!historyHasMore || !historyCursor || historyLoadingMore) return;

    setHistoryLoadingMore(true);
    setHistoryError(null);

    try {
      const result = await api.getGitHistory(projectId, {
        cursor: historyCursor,
        limit: 25,
        branch: effectiveViewingBranch ?? undefined,
      });

      setHistoryCommits((prev) => {
        const existingHashes = new Set(prev.map((commit) => commit.hash));
        const appended = result.commits.filter(
          (commit) => !existingHashes.has(commit.hash),
        );
        return [...prev, ...appended];
      });
      setHistoryHasMore(result.hasMore);
      setHistoryCursor(result.nextCursor);
    } catch (err) {
      setHistoryError(
        err instanceof Error ? err.message : t("sourceManagerActionFailed"),
      );
    } finally {
      setHistoryLoadingMore(false);
    }
  };

  const {
    actionError,
    alternateSyncAction,
    branchMenuError,
    branchMenuOpen,
    branchSwitchMode,
    branches,
    busyAction,
    confirmBranchSwitch,
    confirmDiscardAllChanges,
    confirmDiscardStash,
    discardConfirmOpen,
    discardStashConfirmRef,
    handleSwitchBranch,
    handleCreateBranch,
    handleCommit,
    handleConfirmUndo,
    handleDiscardAllChanges,
    handleDiscardStash,
    handleMergeBranch,
    handleOpenMergeModal,
    handleRestoreStash,
    handleStashAllChanges,
    handleSync,
    handleToggleBranchMenu,
    handleUndoClick,
    hideDiscardWarningChecked,
    hideUndoWarningChecked,
    createModalOpen,
    mergeError,
    mergeModalOpen,
    pendingBranch,
    setBranchMenuOpen,
    setBranchSwitchMode,
    setCreateModalOpen,
    setDiscardConfirmOpen,
    setDiscardStashConfirmRef,
    setFileActionWarnings,
    setMergeError,
    setMergeModalOpen,
    setPendingBranch,
    setSyncMenuOpen,
    setUndoConfirmOpen,
    syncAction,
    syncMenuOpen,
    undoConfirmOpen,
  } = useGitStatusActions({
    projectId,
    status,
    refetch,
    applyStatus,
    t,
    selectedCommitPaths,
    commitMessage,
    setCommitMessage,
    onSwitchSuccess: () => setViewingBranch(null),
  });

  // 失效处理：查看的分支已被删除时回退到跟随当前分支
  // Invalidation: fall back to following current branch when viewed branch is deleted
  useEffect(() => {
    if (!viewingBranch) return;
    if (branches.length === 0) return; // 分支列表尚未加载，等待
    const stillExists = branches.some((b) => b.name === viewingBranch);
    if (!stillExists) {
      setViewingBranch(null);
    }
  }, [viewingBranch, branches]);

  return (
    <div className="git-desktop">
      <GitStatusSummaryBar
        status={status}
        isLoading={isLoading}
        branches={branches}
        branchMenuError={branchMenuError}
        branchMenuOpen={branchMenuOpen}
        busyAction={busyAction}
        syncAction={syncAction}
        syncMenuOpen={syncMenuOpen}
        alternateSyncAction={alternateSyncAction}
        remoteName={remoteName}
        t={t}
        onBranchMenuToggle={handleToggleBranchMenu}
        onBranchMenuClose={() => setBranchMenuOpen(false)}
        onBranchSelectView={handleSelectViewBranch}
        onSwitchBranch={handleSwitchBranch}
        viewingBranch={viewingBranch}
        isViewingCurrent={isViewingCurrent}
        onOpenCreateBranch={(branchName) => {
          setBranchMenuOpen(false);
          setCreateBranchInitialName(branchName);
          setCreateModalOpen(true);
        }}
        onOpenMerge={handleOpenMergeModal}
        onSync={handleSync}
        onSyncMenuToggle={() => setSyncMenuOpen((value) => !value)}
        onSyncMenuClose={() => setSyncMenuOpen(false)}
      />

      {actionError && <div className="error">{actionError}</div>}

      <div className="git-desktop-shell">
        <GitStatusSidebar
          status={status}
          isLoading={isLoading}
          projectId={projectId}
          activeView={activeView}
          viewingBranch={viewingBranch}
          currentBranch={status.branch}
          commitMessage={commitMessage}
          fileFilter={fileFilter}
          fileActionsMenuOpen={fileActionsMenuOpen}
          selectedCommitCount={selectedCommitCount}
          visibleFiles={visibleFiles}
          historyCommits={historyCommits}
          historyLoading={historyLoading}
          historyLoadingMore={historyLoadingMore}
          historyError={historyError}
          historyHasMore={historyHasMore}
          selectedStashRef={selectedStashRef}
          selectedHistoryCommitHash={selectedHistoryCommitHash}
          selectedFile={selectedFile}
          stashes={status.stashes}
          excludedCommitFileKeys={excludedCommitFileKeys}
          busyAction={busyAction}
          canCommit={canCommit}
          canUndo={status.ahead > 0}
          t={t}
          onCommitMessageChange={setCommitMessage}
          onCommit={handleCommit}
          onUndo={handleUndoClick}
          onFileFilterChange={setFileFilter}
          onClearFileFilter={() => setFileFilter("")}
          onViewChange={setActiveView}
          onToggleFileActionsMenu={() =>
            setFileActionsMenuOpen((value) => !value)
          }
          onCloseFileActionsMenu={() => setFileActionsMenuOpen(false)}
          onDiscardSelected={() => {
            setFileActionsMenuOpen(false);
            handleDiscardAllChanges();
          }}
          onStashSelected={() => {
            setFileActionsMenuOpen(false);
            handleStashAllChanges();
          }}
          onFileClick={handleFileClick}
          onHistoryCommitSelect={setSelectedHistoryCommitHash}
          onLoadMoreHistory={handleLoadMoreHistory}
          onStashSelect={setSelectedStashRef}
          onToggleCommitFile={handleCommitFileToggle}
          onSetCommitFiles={handleCommitFilesSelection}
          /* 文件 tab 相关 / Files tab related */
          fileTreeSearchQuery={fileTreeSearchQuery}
          fileTreeSelectedPath={fileTreeSelectedPath}
          onFileTreeSearchChange={setFileTreeSearchQuery}
          onFileTreeFileClick={setFileTreeSelectedPath}
          fileTreeRefreshKey={fileTreeRefreshKey}
          /* 刷新相关 / Refresh related */
          refreshingActiveView={refreshingActiveView}
          onRefreshActiveView={handleRefreshActiveView}
          projectPath={projectPath}
          onRenameFile={handleRenameFile}
          onDeleteFile={handleDeleteFile}
        />

        {!isNarrowScreen && (
          <section className="git-desktop-card git-preview-card">
            {activeView === "files" ? (
              fileTreeSelectedPath ? (
                <FileViewer
                  projectId={projectId}
                  filePath={fileTreeSelectedPath}
                />
              ) : (
                <div className="git-preview-empty">
                  {t("sourceManagerFileSelectToView")}
                </div>
              )
            ) : activeView === "history" ? (
              <GitCommitHistoryPane
                projectId={projectId}
                selectedCommitHash={selectedHistoryCommitHash}
                t={t}
                previewInline={!isMediumScreen}
                onCommitLoaded={setHistoryModalCommit}
                onFileSelect={(file, historyCommit) =>
                  setHistoryPreviewModal({ file, historyCommit })
                }
                projectPath={projectPath}
              />
            ) : activeView === "stashed" ? (
              <GitStashPane
                projectId={projectId}
                selectedStashRef={selectedStashRef}
                busyAction={busyAction}
                t={t}
                onDiscard={(stashRef) => {
                  handleDiscardStash(stashRef);
                }}
                onRestore={(stashRef) => {
                  handleRestoreStash(stashRef, () => {
                    setActiveView("changes");
                    setSelectedStashRef(null);
                  });
                }}
                previewInline={!isMediumScreen}
                onStashLoaded={setStashModal}
                onFileSelect={(file, stashRef) =>
                  setStashPreviewModal({ file, stashRef })
                }
                projectPath={projectPath}
              />
            ) : selectedFile ? (
              <GitPreviewPane file={selectedFile} projectId={projectId} t={t} />
            ) : (
              <div className="git-preview-empty">
                {status.files.length === 0
                  ? t("gitStatusWorkingTreeClean")
                  : t("sourceManagerSelectFilePreview")}
              </div>
            )}
          </section>
        )}

      </div>

      {isNarrowScreen && previewModalFile ? (
        <Modal
          title={<FilePathTitle file={previewModalFile} />}
          onClose={() => setPreviewModalFile(null)}
          backCloses
        >
          <div className="git-preview-modal-content">
            <GitPreviewPane
              file={previewModalFile}
              projectId={projectId}
              t={t}
            />
          </div>
        </Modal>
      ) : null}

      {isNarrowScreen &&
      activeView === "files" &&
      fileTreeSelectedPath ? (
        <Modal
          title={fileTreeSelectedPath}
          onClose={() => setFileTreeSelectedPath(null)}
          backCloses
        >
          <div className="git-preview-modal-content">
            <FileViewer
              projectId={projectId}
              filePath={fileTreeSelectedPath}
            />
          </div>
        </Modal>
      ) : null}

      {isNarrowScreen &&
      activeView === "history" &&
      selectedHistoryCommitHash ? (
        <Modal
          title={historyModalCommit?.message ?? t("gitStatusLoading")}
          onClose={() => {
            setSelectedHistoryCommitHash(null);
            setHistoryModalCommit(null);
          }}
          backCloses
        >
          <div className="git-preview-modal-content">
            <GitCommitHistoryPane
              projectId={projectId}
              selectedCommitHash={selectedHistoryCommitHash}
              t={t}
              previewInline={false}
              onCommitLoaded={setHistoryModalCommit}
              onFileSelect={(file, historyCommit) =>
                setHistoryPreviewModal({ file, historyCommit })
              }
              projectPath={projectPath}
            />
          </div>
        </Modal>
      ) : null}

      {isMediumScreen && historyPreviewModal ? (
        <Modal
          title={<FilePathTitle file={historyPreviewModal.file} />}
          onClose={() => setHistoryPreviewModal(null)}
          backCloses
        >
          <div className="git-preview-modal-content">
            <GitPreviewPane
              file={historyPreviewModal.file}
              projectId={projectId}
              t={t}
              historyCommit={historyPreviewModal.historyCommit}
            />
          </div>
        </Modal>
      ) : null}

      {isNarrowScreen &&
      activeView === "stashed" &&
      selectedStashRef ? (
        <Modal
          title={
            stashModal
              ? stashModal.createdByApp
                ? t("sourceManagerStashedTitle")
                : stashModal.message
              : t("gitStatusLoading")
          }
          onClose={() => {
            setSelectedStashRef(null);
            setStashModal(null);
          }}
          backCloses
        >
          <div className="git-preview-modal-content">
            <GitStashPane
              projectId={projectId}
              selectedStashRef={selectedStashRef}
              busyAction={busyAction}
              t={t}
              onDiscard={(stashRef) => {
                handleDiscardStash(stashRef);
              }}
              onRestore={(stashRef) => {
                handleRestoreStash(stashRef, () => {
                  setStashModal(null);
                  setSelectedStashRef(null);
                  setActiveView("changes");
                });
              }}
              previewInline={false}
              onStashLoaded={setStashModal}
              onFileSelect={(file, stashRef) =>
                setStashPreviewModal({ file, stashRef })
              }
              projectPath={projectPath}
            />
          </div>
        </Modal>
      ) : null}

      {isMediumScreen && stashPreviewModal ? (
        <Modal
          title={<FilePathTitle file={stashPreviewModal.file} />}
          onClose={() => setStashPreviewModal(null)}
          backCloses
        >
          <div className="git-preview-modal-content">
            <GitPreviewPane
              file={stashPreviewModal.file}
              projectId={projectId}
              t={t}
              stashRef={stashPreviewModal.stashRef}
            />
          </div>
        </Modal>
      ) : null}

      {undoConfirmOpen ? (
        <GitConfirmationModal
          title={t("sourceManagerUndoConfirmTitle")}
          message={t("sourceManagerUndoConfirmBody")}
          skipChecked={hideUndoWarningChecked}
          onSkipCheckedChange={setFileActionWarnings.setHideUndoWarningChecked}
          skipLabel={t("sourceManagerUndoConfirmSkip")}
          cancelLabel={t("sourceManagerBranchCancel")}
          confirmLabel={
            busyAction === "undo"
              ? t("gitStatusLoading")
              : t("sourceManagerUndoConfirmContinue")
          }
          busy={busyAction !== null}
          onClose={() => setUndoConfirmOpen(false)}
          onConfirm={handleConfirmUndo}
        />
      ) : null}

      {discardConfirmOpen ? (
        <GitConfirmationModal
          title={t("sourceManagerDiscardAllTitle")}
          message={t("sourceManagerDiscardAllPrompt")}
          details={
            <>
              <div className="git-discard-confirm-target">
                {selectedCommitCount === 1
                  ? selectedCommitFiles[0]?.path
                  : t("sourceManagerSelectedFilesCount", {
                      count: selectedCommitCount,
                    })}
              </div>
              <p className="git-discard-confirm-detail">
                {t("sourceManagerDiscardAllBody")}
              </p>
            </>
          }
          skipChecked={hideDiscardWarningChecked}
          onSkipCheckedChange={
            setFileActionWarnings.setHideDiscardWarningChecked
          }
          skipLabel={t("sourceManagerUndoConfirmSkip")}
          cancelLabel={t("sourceManagerBranchCancel")}
          confirmLabel={
            busyAction === "discard"
              ? t("gitStatusLoading")
              : t("sourceManagerDiscardAllConfirm")
          }
          busy={busyAction !== null}
          onClose={() => setDiscardConfirmOpen(false)}
          onConfirm={confirmDiscardAllChanges}
        />
      ) : null}

      {discardStashConfirmRef ? (
        <GitConfirmationModal
          title={t("sourceManagerStashedDiscardTitle")}
          message={t("sourceManagerStashedDiscardPrompt")}
          details={
            <>
              <div className="git-discard-confirm-target">
                {stashModal?.createdByApp
                  ? t("sourceManagerStashedTitle")
                  : stashModal?.message || discardStashConfirmRef}
              </div>
              <p className="git-discard-confirm-detail">
                {t("sourceManagerStashedDiscardBody")}
              </p>
            </>
          }
          cancelLabel={t("sourceManagerBranchCancel")}
          confirmLabel={
            busyAction === "discardStash"
              ? t("gitStatusLoading")
              : t("sourceManagerStashedDiscardConfirm")
          }
          busy={busyAction !== null}
          onClose={() => setDiscardStashConfirmRef(null)}
          onConfirm={() =>
            confirmDiscardStash(() => {
              setStashModal(null);
              setSelectedStashRef(null);
              setActiveView("changes");
            })
          }
        />
      ) : null}

      {pendingBranch ? (
        <GitBranchSwitchModal
          currentBranch={status.branch ?? t("sourceManagerCurrentBranchFallback")}
          targetBranch={pendingBranch.targetBranch}
          mode={branchSwitchMode}
          busy={busyAction === "switch"}
          onModeChange={setBranchSwitchMode}
          onClose={() => setPendingBranch(null)}
          onConfirm={() => confirmBranchSwitch(branchSwitchMode === "stash")}
        />
      ) : null}

      {createModalOpen ? (
        <GitBranchCreateModal
          currentBranch={status.branch ?? t("sourceManagerCurrentBranchFallback")}
          branches={branches}
          initialBranchName={createBranchInitialName}
          busy={busyAction === "switch"}
          onClose={() => {
            if (busyAction === "switch") return;
            setCreateModalOpen(false);
          }}
          onConfirm={(branchName, baseBranch) => {
            setCreateModalOpen(false);
            handleCreateBranch(branchName, baseBranch);
          }}
        />
      ) : null}

      {mergeModalOpen ? (
        <GitBranchMergeModal
          projectId={projectId}
          currentBranch={status.branch ?? t("sourceManagerCurrentBranchFallback")}
          branches={branches}
          busy={busyAction === "merge"}
          error={mergeError}
          onClose={() => {
            if (busyAction === "merge") return;
            setMergeModalOpen(false);
            setMergeError(null);
          }}
          onConfirm={handleMergeBranch}
        />
      ) : null}

      {/* 重命名文件模态框 / Rename file modal */}
      {renameFileState ? (
        <Modal
          title={t("sourceManagerFileContextRenameTitle")}
          onClose={() => {
            if (renameFileBusy) return;
            setRenameFileState(null);
          }}
          backCloses
        >
          <div className="git-rename-form">
            <input
              id="git-rename-input"
              type="text"
              className="git-rename-input"
              value={renameFileNewName}
              onChange={(e) => {
                setRenameFileNewName(e.target.value);
                setRenameFileError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleRenameFileConfirm();
              }}
              placeholder={renameFileState.name}
            />
            {renameFileError && (
              <p className="git-diff-error">{renameFileError}</p>
            )}
            <div className="git-rename-actions">
              <Button
                variant="primary"
                onClick={handleRenameFileConfirm}
                disabled={renameFileBusy || !renameFileNewName.trim()}
              >
                {renameFileBusy
                  ? t("gitStatusLoading")
                  : t("sourceManagerFileContextRenameConfirm")}
              </Button>
              <Button
                variant="secondary"
                onClick={() => setRenameFileState(null)}
              >
                {t("sourceManagerFileContextRenameCancel")}
              </Button>
            </div>
          </div>
        </Modal>
      ) : null}

      {/* 删除文件确认模态框 / Delete file confirmation modal */}
      {deleteFileState ? (
        <GitConfirmationModal
          title={
            deleteFileState.isDirectory
              ? t("sourceManagerFileContextDeleteDirTitle")
              : t("sourceManagerFileContextDeleteFileTitle")
          }
          message={t("sourceManagerFileContextDeleteMessage", {
            name: deleteFileState.name,
          })}
          details={
            <p className="git-discard-confirm-detail">
              {t("sourceManagerFileContextDeleteBody")}
            </p>
          }
          cancelLabel={t("sourceManagerFileContextDeleteCancel")}
          confirmLabel={
            deleteFileBusy
              ? t("gitStatusLoading")
              : t("sourceManagerFileContextDeleteConfirm")
          }
          busy={deleteFileBusy}
          onClose={() => {
            if (deleteFileBusy) return;
            setDeleteFileState(null);
          }}
          onConfirm={handleDeleteFileConfirm}
        />
      ) : null}
    </div>
  );
}
