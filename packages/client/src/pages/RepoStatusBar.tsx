import type { GitStatusInfo } from "@yep-anywhere/shared";
import { CopyButton } from "../components/CopyButton";
import type { TranslationFn } from "../i18n";

/**
 * Persistent branch status in the Source Control identity header. Project,
 * branch, upstream, and clean/dirty state stay together while mode navigation
 * and repository actions use their own layout regions.
 */
export function RepoStatusBar({
  status,
  onSelectChanges,
  t,
}: {
  status: GitStatusInfo;
  /** Make a dirty badge open the working-tree Changes mode. */
  onSelectChanges?: () => void;
  t: TranslationFn;
}) {
  const outOfSync = status.ahead > 0 || status.behind > 0;
  const warn = !status.isClean || outOfSync;

  return (
    <div
      className={`repo-status-bar inline ${
        warn ? "repo-status-bar-warn" : ""
      }`}
    >
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
    </div>
  );
}
