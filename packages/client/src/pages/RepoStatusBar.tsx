import type { GitStatusInfo } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { CopyButton } from "../components/CopyButton";
import type { TranslationFn } from "../i18n";

/**
 * Persistent repo/branch status header (topic: source-review-to-session, stage
 * 3). Names the repo and branch and turns a warning color when the worktree is
 * dirty or the branch is ahead/behind upstream. Read-only — it surfaces status
 * and offers copy affordances (branch name). Shown across all source-control
 * modes, so the status stays visible while browsing commits or files. The
 * mode tabs, upstream actions, and review-tray button live in this same row
 * (via the slots) so the surface has a single toolbar row instead of stacking
 * a second one.
 */
export function RepoStatusBar({
  repoName,
  status,
  tabs,
  actions,
  onSelectChanges,
  inline = false,
  t,
}: {
  repoName?: string;
  status: GitStatusInfo;
  /** The source-mode tabs. Leading in the scrollable mobile row, trailing inline. */
  tabs?: ReactNode;
  /** Trailing controls (e.g. the review-tray button), after the badge. */
  actions?: ReactNode;
  /** Make a dirty badge open the working-tree Changes mode. */
  onSelectChanges?: () => void;
  /** Compose status into PageHeader chrome instead of rendering a separate bar. */
  inline?: boolean;
  t: TranslationFn;
}) {
  const outOfSync = status.ahead > 0 || status.behind > 0;
  const warn = !status.isClean || outOfSync;

  return (
    <div
      className={`repo-status-bar ${inline ? "inline" : ""} ${
        warn ? "repo-status-bar-warn" : ""
      }`}
    >
      {!inline && tabs}
      {repoName && <span className="repo-status-name">{repoName}</span>}
      <span className="repo-status-branch">
        <svg
          width="13"
          height="13"
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
        <span className="repo-status-branch-name">
          {status.branch ?? t("gitStatusDetachedHead")}
        </span>
        {status.branch && (
          <CopyButton value={status.branch} title={t("sourceCopyBranch")} />
        )}
      </span>
      {status.upstream && (
        <span className="repo-status-upstream" title={status.upstream}>
          → {status.upstream}
        </span>
      )}
      {outOfSync && (
        <span className="repo-status-sync">
          {status.ahead > 0 && ` ↑${status.ahead}`}
          {status.behind > 0 && ` ↓${status.behind}`}
        </span>
      )}
      {!status.isClean && onSelectChanges ? (
        <button
          type="button"
          className="repo-status-badge dirty repo-status-badge-action"
          title={t("sourceOpenChanges")}
          onClick={onSelectChanges}
        >
          {t("gitStatusDirty")}
        </button>
      ) : (
        <span
          className={`repo-status-badge ${status.isClean ? "clean" : "dirty"}`}
        >
          {status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
        </span>
      )}
      {inline && tabs}
      {actions}
    </div>
  );
}
