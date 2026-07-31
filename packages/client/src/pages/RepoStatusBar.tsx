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
  className,
  t,
}: {
  status: GitStatusInfo;
  /** Make a dirty badge open the working-tree Changes mode. */
  onSelectChanges?: () => void;
  /** Caller-supplied placement class for the header region that holds the bar. */
  className?: string;
  t: TranslationFn;
}) {
  const outOfSync = status.ahead > 0 || status.behind > 0;
  const warn = !status.isClean || outOfSync;

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
        <span className={styles.branchName}>
          {status.branch ?? t("gitStatusDetachedHead")}
        </span>
        {status.branch && (
          <CopyButton
            value={status.branch}
            title={t("sourceCopyBranch")}
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
