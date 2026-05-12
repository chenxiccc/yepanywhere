import type { GitMergeStrategy } from "@yep-anywhere/shared";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { GitBranchMergeModal } from "../components/GitBranchMergeModal";
import { GitBranchSwitchModal } from "../components/GitBranchSwitchModal";
import { PageHeader } from "../components/PageHeader";
import { ProjectSelector } from "../components/ProjectSelector";
import { GitConfirmationModal } from "../components/git-status/GitConfirmationModal";
import { GitPreviewPane } from "../components/git-status/GitPreviewPane";
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

        <main className="page-scroll-container">
          <div className="page-content-inner">
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
  const [commitMessage, setCommitMessage] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [fileActionsMenuOpen, setFileActionsMenuOpen] = useState(false);

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
    discardConfirmOpen,
    handleBranchSelect,
    handleCommit,
    handleConfirmUndo,
    handleDiscardAllChanges,
    handleMergeBranch,
    handleOpenMergeModal,
    handleStashAllChanges,
    handleSync,
    handleToggleBranchMenu,
    handleUndoClick,
    hideDiscardWarningChecked,
    hideUndoWarningChecked,
    mergeError,
    mergeModalOpen,
    pendingBranch,
    setBranchMenuOpen,
    setBranchSwitchMode,
    setDiscardConfirmOpen,
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
        onOpenMerge={handleOpenMergeModal}
        onSync={handleSync}
        onSyncMenuToggle={() => setSyncMenuOpen((value) => !value)}
        onSyncMenuClose={() => setSyncMenuOpen(false)}
      />

      {actionError && <div className="error">{actionError}</div>}

      <div className="git-desktop-shell">
        <GitStatusSidebar
          status={status}
          commitMessage={commitMessage}
          fileFilter={fileFilter}
          fileActionsMenuOpen={fileActionsMenuOpen}
          selectedCommitCount={selectedCommitCount}
          visibleFiles={visibleFiles}
          selectedFile={selectedFile}
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
          onToggleCommitFile={handleCommitFileToggle}
          onSetCommitFiles={handleCommitFilesSelection}
        />

        {!isNarrowScreen && (
          <section className="git-desktop-card git-preview-card">
            {selectedFile ? (
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

      {pendingBranch ? (
        <GitBranchSwitchModal
          currentBranch={status.branch ?? t("gitStatusCurrentBranchFallback")}
          targetBranch={pendingBranch}
          mode={branchSwitchMode}
          busy={busyAction === "switch"}
          onModeChange={setBranchSwitchMode}
          onClose={() => setPendingBranch(null)}
          onConfirm={() => confirmBranchSwitch(branchSwitchMode === "stash")}
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
