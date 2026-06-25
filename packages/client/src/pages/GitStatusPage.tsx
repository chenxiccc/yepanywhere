import type {
  GitFileChange,
  GitHistoryCommitDetail,
  GitHistoryCommitSummary,
  GitMergeStrategy,
  GitStashDetail,
} from "@yep-anywhere/shared";
import { useEffect, useMemo, useState } from "react";
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
import { Modal } from "../components/ui/Modal";
import { useDocumentTitle } from "../hooks/useDocumentTitle";
import { useGitStatus } from "../hooks/useGitStatus";
import { useGitStatusActions } from "../hooks/useGitStatusActions";
import { useGitStatusSelection } from "../hooks/useGitStatusSelection";
import { useMediaQuery } from "../hooks/useMediaQuery";
import { useProject, useProjects } from "../hooks/useProjects";
import { useI18n } from "../i18n";
import "../styles/git-status.css";
import { useNavigationLayout } from "../layouts";

export function GitStatusPage() {
  const { t } = useI18n();
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get("projectId");
  const { openSidebar, isWideScreen, toggleSidebar, isSidebarCollapsed } =
    useNavigationLayout();

  const { projects, loading: projectsLoading } = useProjects();
  const effectiveProjectId = projectId || projects[0]?.id;
  const { project } = useProject(effectiveProjectId);
  const { gitStatus, loading, error, refetch } =
    useGitStatus(effectiveProjectId);

  useDocumentTitle(project?.name, t("gitStatusTitle"));

  const handleProjectChange = (newProjectId: string) => {
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
            {loading || projectsLoading ? (
              <div className="loading">{t("gitStatusLoading")}</div>
            ) : error ? (
              <div className="error">
                {t("gitStatusErrorPrefix")} {error.message}
              </div>
            ) : gitStatus && !gitStatus.isGitRepo ? (
              <div className="git-status-empty">{t("gitStatusNotRepo")}</div>
            ) : gitStatus && effectiveProjectId ? (
              <GitStatusContent
                status={gitStatus}
                projectId={effectiveProjectId}
                refetch={refetch}
                t={t as never}
              />
            ) : null}
          </div>
        </main>
      </div>
    </div>
  );
}

function GitStatusContent({
  status,
  projectId,
  refetch,
  t,
}: {
  status: import("@yep-anywhere/shared").GitStatusInfo;
  projectId: string;
  refetch: () => Promise<void>;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const isNarrowScreen = useMediaQuery("(max-width: 900px)");
  const isMediumScreen = useMediaQuery("(max-width: 1099px)");
  const [activeView, setActiveView] = useState<
    "changes" | "stashed" | "history"
  >("changes");
  const [commitMessage, setCommitMessage] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [fileActionsMenuOpen, setFileActionsMenuOpen] = useState(false);
  const [historyCommits, setHistoryCommits] = useState<
    GitHistoryCommitSummary[]
  >([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyLoadingMore, setHistoryLoadingMore] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [createBranchInitialName, setCreateBranchInitialName] = useState("");
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
  const historyReloadKey = `${status.branch ?? ""}:${status.ahead}:${status.behind}`;

  useEffect(() => {
    let cancelled = false;

    if (activeView !== "history" || historyReloadKey.length === 0) return;

    setHistoryLoading(true);
    setHistoryLoadingMore(false);
    setHistoryError(null);
    setHistoryCommits([]);
    setHistoryHasMore(false);
    setHistoryCursor(null);
    setSelectedHistoryCommitHash(null);

    api
      .getGitHistory(projectId, { limit: 25 })
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
          err instanceof Error ? err.message : t("gitStatusActionFailed"),
        );
        setHistoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeView, historyReloadKey, projectId, t]);

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
        err instanceof Error ? err.message : t("gitStatusActionFailed"),
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
    handleBranchSelect,
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
    t,
    selectedCommitPaths,
    commitMessage,
    setCommitMessage,
  });

  return (
    <div className="git-desktop">
      <GitStatusSummaryBar
        status={status}
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
        onBranchSelect={handleBranchSelect}
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
          activeView={activeView}
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
        />

        {!isNarrowScreen && (
          <section className="git-desktop-card git-preview-card">
            {activeView === "history" ? (
              <GitCommitHistoryPane
                projectId={projectId}
                selectedCommitHash={selectedHistoryCommitHash}
                t={t}
                previewInline={!isMediumScreen}
                onCommitLoaded={setHistoryModalCommit}
                onFileSelect={(file, historyCommit) =>
                  setHistoryPreviewModal({ file, historyCommit })
                }
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
              />
            ) : selectedFile ? (
              <GitPreviewPane file={selectedFile} projectId={projectId} t={t} />
            ) : (
              <div className="git-preview-empty">
                {status.files.length === 0
                  ? t("gitStatusWorkingTreeClean")
                  : t("gitStatusSelectFilePreview")}
              </div>
            )}
          </section>
        )}

      </div>

      {isNarrowScreen && previewModalFile ? (
        <Modal
          title={<FilePathTitle file={previewModalFile} />}
          onClose={() => setPreviewModalFile(null)}
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
      activeView === "history" &&
      selectedHistoryCommitHash ? (
        <Modal
          title={historyModalCommit?.message ?? t("gitStatusLoading")}
          onClose={() => {
            setSelectedHistoryCommitHash(null);
            setHistoryModalCommit(null);
          }}
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
            />
          </div>
        </Modal>
      ) : null}

      {isMediumScreen && historyPreviewModal ? (
        <Modal
          title={<FilePathTitle file={historyPreviewModal.file} />}
          onClose={() => setHistoryPreviewModal(null)}
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
                ? t("gitStatusStashedTitle")
                : stashModal.message
              : t("gitStatusLoading")
          }
          onClose={() => {
            setSelectedStashRef(null);
            setStashModal(null);
          }}
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
            />
          </div>
        </Modal>
      ) : null}

      {isMediumScreen && stashPreviewModal ? (
        <Modal
          title={<FilePathTitle file={stashPreviewModal.file} />}
          onClose={() => setStashPreviewModal(null)}
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
          title={t("gitStatusUndoConfirmTitle")}
          message={t("gitStatusUndoConfirmBody")}
          skipChecked={hideUndoWarningChecked}
          onSkipCheckedChange={setFileActionWarnings.setHideUndoWarningChecked}
          skipLabel={t("gitStatusUndoConfirmSkip")}
          cancelLabel={t("gitStatusBranchCancel")}
          confirmLabel={
            busyAction === "undo"
              ? t("gitStatusLoading")
              : t("gitStatusUndoConfirmContinue")
          }
          busy={busyAction !== null}
          onClose={() => setUndoConfirmOpen(false)}
          onConfirm={handleConfirmUndo}
        />
      ) : null}

      {discardConfirmOpen ? (
        <GitConfirmationModal
          title={t("gitStatusDiscardAllTitle")}
          message={t("gitStatusDiscardAllPrompt")}
          details={
            <>
              <div className="git-discard-confirm-target">
                {selectedCommitCount === 1
                  ? selectedCommitFiles[0]?.path
                  : t("gitStatusSelectedFilesCount", {
                      count: selectedCommitCount,
                    })}
              </div>
              <p className="git-discard-confirm-detail">
                {t("gitStatusDiscardAllBody")}
              </p>
            </>
          }
          skipChecked={hideDiscardWarningChecked}
          onSkipCheckedChange={
            setFileActionWarnings.setHideDiscardWarningChecked
          }
          skipLabel={t("gitStatusUndoConfirmSkip")}
          cancelLabel={t("gitStatusBranchCancel")}
          confirmLabel={
            busyAction === "discard"
              ? t("gitStatusLoading")
              : t("gitStatusDiscardAllConfirm")
          }
          busy={busyAction !== null}
          onClose={() => setDiscardConfirmOpen(false)}
          onConfirm={confirmDiscardAllChanges}
        />
      ) : null}

      {discardStashConfirmRef ? (
        <GitConfirmationModal
          title={t("gitStatusStashedDiscardTitle")}
          message={t("gitStatusStashedDiscardPrompt")}
          details={
            <>
              <div className="git-discard-confirm-target">
                {stashModal?.createdByApp
                  ? t("gitStatusStashedTitle")
                  : stashModal?.message || discardStashConfirmRef}
              </div>
              <p className="git-discard-confirm-detail">
                {t("gitStatusStashedDiscardBody")}
              </p>
            </>
          }
          cancelLabel={t("gitStatusBranchCancel")}
          confirmLabel={
            busyAction === "discardStash"
              ? t("gitStatusLoading")
              : t("gitStatusStashedDiscardConfirm")
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
          currentBranch={status.branch ?? t("gitStatusCurrentBranchFallback")}
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
          currentBranch={status.branch ?? t("gitStatusCurrentBranchFallback")}
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
          currentBranch={status.branch ?? t("gitStatusCurrentBranchFallback")}
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
    </div>
  );
}
