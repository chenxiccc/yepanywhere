import type { GitBranchInfo, SourceManagerStatusInfo } from "@yep-anywhere/shared";
import { GitBranchSwitcher, GitSplitActionButton } from "./GitBranchControls";
import { SyncIcon } from "./GitStatusIcons";

type Translate = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function GitStatusSummaryBar({
  status,
  branches,
  branchMenuError,
  branchMenuOpen,
  busyAction,
  syncAction,
  syncMenuOpen,
  alternateSyncAction,
  remoteName,
  t,
  onBranchMenuToggle,
  onBranchMenuClose,
  onBranchSelectView,
  onSwitchBranch,
  viewingBranch,
  isViewingCurrent,
  onOpenCreateBranch,
  onOpenMerge,
  onSync,
  onSyncMenuToggle,
  onSyncMenuClose,
}: {
  status: SourceManagerStatusInfo;
  branches: GitBranchInfo[];
  branchMenuError: string | null;
  branchMenuOpen: boolean;
  busyAction: string | null;
  syncAction: "fetch" | "push" | null;
  syncMenuOpen: boolean;
  alternateSyncAction: "fetch" | "push" | null;
  remoteName: string;
  t: Translate;
  onBranchMenuToggle: () => void;
  onBranchMenuClose: () => void;
  onBranchSelectView: (branchName: string) => void;
  onSwitchBranch: (branchName: string) => void;
  /** 当前查看的分支（null=跟随当前 checkout）/ Currently viewing branch (null=follow checkout) */
  viewingBranch: string | null;
  /** 查看的是否为当前已 checkout 分支 / Whether viewing == checked-out branch */
  isViewingCurrent: boolean;
  onOpenCreateBranch: (branchName: string) => void;
  onOpenMerge: () => void;
  onSync: (action: "fetch" | "push") => void;
  onSyncMenuToggle: () => void;
  onSyncMenuClose: () => void;
}) {
  return (
    <div className="git-desktop-toolbar">
      <div className="git-status-branch git-desktop-branch-card">
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
        {/* 查看=已 checkout 分支时显示 HEAD pill；查看其他分支时不显示（顶部直接显查看分支名） */}
        {/* HEAD pill shown when viewing == checked-out branch; hidden when viewing another */}
        {isViewingCurrent && (
          <span
            className="git-head-badge"
            role="img"
            aria-label={t("sourceManagerViewingCurrentBranch")}
          >
            HEAD
          </span>
        )}
        <GitBranchSwitcher
          currentBranch={status.branch ?? t("gitStatusDetachedHead")}
          branches={branches}
          isOpen={branchMenuOpen}
          onToggle={onBranchMenuToggle}
          onClose={onBranchMenuClose}
          onSelectView={onBranchSelectView}
          onSwitchBranch={onSwitchBranch}
          viewingBranch={viewingBranch}
          onOpenCreateBranch={onOpenCreateBranch}
          onOpenMerge={onOpenMerge}
          error={branchMenuError}
        />
        {((syncAction !== "push" && status.ahead > 0) ||
          (syncAction !== "fetch" && status.behind > 0)) && (
          <span className="git-ahead-behind">
            {syncAction !== "push" && status.ahead > 0 && `↑${status.ahead}`}
            {syncAction !== "fetch" &&
              status.behind > 0 &&
              ` ↓${status.behind}`}
          </span>
        )}
        <span
          className={`git-clean-badge ${status.isClean ? "git-clean" : "git-dirty"}`}
          title={status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
        >
          <span className="git-clean-indicator" aria-hidden="true" />
        </span>
        {syncAction ? (
          <div className="git-branch-sync-actions">
            <GitSplitActionButton
              label={
                busyAction === syncAction
                  ? syncAction === "fetch"
                    ? t("sourceManagerFetchingWithRemote", { remote: remoteName })
                    : t("gitStatusLoading")
                  : syncAction === "fetch"
                    ? t("sourceManagerFetchWithRemote", { remote: remoteName })
                    : t("sourceManagerPushWithRemote", { remote: remoteName })
              }
              disabled={busyAction !== null}
              onClick={() => onSync(syncAction)}
              icon={<SyncIcon />}
              count={
                syncAction === "fetch"
                  ? status.behind > 0
                    ? `${status.behind}↓`
                    : undefined
                  : status.ahead > 0
                    ? `${status.ahead}↑`
                    : undefined
              }
              menuOpen={syncMenuOpen}
              onToggleMenu={onSyncMenuToggle}
              onCloseMenu={onSyncMenuClose}
              alternateAction={
                alternateSyncAction
                  ? {
                      label:
                        alternateSyncAction === "fetch"
                          ? t("sourceManagerFetchWithRemote", {
                              remote: remoteName,
                            })
                          : t("sourceManagerPushWithRemote", {
                              remote: remoteName,
                            }),
                      onClick: () => onSync(alternateSyncAction),
                    }
                  : null
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
