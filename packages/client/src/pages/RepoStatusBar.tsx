import type { GitStatusInfo } from "@yep-anywhere/shared";
import { CopyButton } from "../components/CopyButton";
import type { TranslationFn } from "../i18n";
import styles from "./RepoStatusBar.module.css";

/**
 * Persistent branch status in the Source Control identity header. Project,
 * branch, upstream, and clean/dirty state stay together while mode navigation
 * and repository actions use their own layout regions.
 */
export function RepoStatusBar({
  status,
  onSelectChanges,
  headCommitHref,
  onOpenHeadCommit,
  className,
  t,
}: {
  status: GitStatusInfo;
  /** Make a dirty badge open the working-tree Changes mode. */
  onSelectChanges?: () => void;
  /** Standalone URL of the branch tip's commit view, for new-tab opening. */
  headCommitHref?: string;
  /** In-page navigation to that same commit, for plain left-click. */
  onOpenHeadCommit?: () => void;
  /** Caller-supplied placement class for the header region that holds the bar. */
  className?: string;
  t: TranslationFn;
}) {
  const outOfSync = status.ahead > 0 || status.behind > 0;
  const warn = !status.isClean || outOfSync;
  // Detached HEAD has no branch name but still has a tip, so the copy control
  // and the commit link both fall back to that SHA.
  const headCommit = status.recentCommits?.[0];
  const branchLabel = status.branch ?? t("gitStatusDetachedHead");
  const copyValue = status.branch ?? headCommit?.hash;
  const opensHeadCommit =
    headCommit !== undefined &&
    headCommitHref !== undefined &&
    onOpenHeadCommit !== undefined;

  return (
    <div
      data-testid="repo-status-bar"
      className={[
        styles.bar,
        styles.inline,
        warn ? styles.warn : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <span className={styles.branch}>
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
        {opensHeadCommit ? (
          <a
            className={`${styles.branchName} ${styles.branchLink}`}
            href={headCommitHref}
            title={t("sourceOpenHeadCommit", { commit: headCommit.shortHash })}
            onClick={(event) => {
              if (
                event.button !== 0 ||
                event.metaKey ||
                event.ctrlKey ||
                event.shiftKey ||
                event.altKey
              ) {
                return;
              }
              event.preventDefault();
              onOpenHeadCommit();
            }}
          >
            {branchLabel}
          </a>
        ) : (
          <span className={styles.branchName}>{branchLabel}</span>
        )}
        {copyValue && (
          <CopyButton
            value={copyValue}
            title={
              status.branch ? t("sourceCopyBranch") : t("sourceCopyCommitHash")
            }
            className={styles.copyButton}
          />
        )}
      </span>
      {status.upstream && (
        <span className={styles.upstream} title={status.upstream}>
          → {status.upstream}
        </span>
      )}
      {outOfSync && (
        <span className={styles.sync}>
          {status.ahead > 0 && ` ↑${status.ahead}`}
          {status.behind > 0 && ` ↓${status.behind}`}
        </span>
      )}
      {!status.isClean && onSelectChanges ? (
        <button
          type="button"
          className={`${styles.badge} ${styles.dirty} ${styles.badgeAction}`}
          title={t("sourceOpenChanges")}
          onClick={onSelectChanges}
        >
          {t("gitStatusDirty")}
        </button>
      ) : (
        <span
          className={`${styles.badge} ${
            status.isClean ? styles.clean : styles.dirty
          }`}
        >
          {status.isClean ? t("gitStatusClean") : t("gitStatusDirty")}
        </span>
      )}
    </div>
  );
}
