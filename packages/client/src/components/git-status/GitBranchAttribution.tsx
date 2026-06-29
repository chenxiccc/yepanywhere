// 归属标注：查看分支 ≠ 当前 checkout 分支时，在 files/changes tab 顶部显示当前 checkout 分支
// Attribution banner: shown at top of files/changes tabs when viewing branch != checked-out branch,
// displays the current checked-out branch as "git icon + HEAD pill + branch name"
function GitBranchIcon() {
  return (
    <span className="git-branch-icon" aria-hidden="true">
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
  );
}

/**
 * 当查看的分支与当前已 checkout 分支不一致时，显示当前 checkout 分支的归属。
 * Shows the checked-out branch attribution when viewed branch differs from checked-out.
 * 视觉：git图标 + HEAD pill + 当前分支名（简洁，无长文案）
 * Visual: git icon + HEAD pill + current branch name (concise, no long copy)
 */
export function GitBranchAttribution({
  currentBranch,
  viewingBranch,
}: {
  /** 当前已 checkout 分支 / Currently checked-out branch */
  currentBranch: string | null;
  /** 当前查看的分支 / Currently viewed branch */
  viewingBranch: string | null;
}) {
  // 仅当查看分支非空且不同于当前分支时显示 / Only show when viewing != current
  if (!viewingBranch || !currentBranch || viewingBranch === currentBranch) {
    return null;
  }

  return (
    <div className="git-branch-attribution" role="note">
      <GitBranchIcon />
      <span className="git-head-badge">HEAD</span>
      <span className="git-attribution-branch">{currentBranch}</span>
    </div>
  );
}
