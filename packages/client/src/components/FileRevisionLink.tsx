import {
  GIT_FILE_REVISION_CAPABILITY,
  type GitFileRevision,
  type GitFileRevisionCommit,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useRetainedVersionInfo } from "../hooks/useVersion";
import { toBrowserAppHref } from "../lib/appHref";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import styles from "./FileRevisionLink.module.css";

export interface FileRevisionLinkProps {
  projectId: string;
  path: string;
  /** Immutable content revision; omission describes the live filesystem. */
  rev?: string;
  /** Historical path for a live, not-yet-committed rename. */
  origPath?: string;
  dirtyLabel: string;
  uncommittedLabel: string;
  className?: string;
}

/** Compact last-revision provenance shared by every file-viewing surface. */
export function FileRevisionLink({
  projectId,
  path,
  rev,
  origPath,
  dirtyLabel,
  uncommittedLabel,
  className,
}: FileRevisionLinkProps) {
  const sourceKey = useClientSummarySourceKey();
  const version = useRetainedVersionInfo(sourceKey);
  const basePath = useRemoteBasePath();
  const supported = serverHasCapability(version, GIT_FILE_REVISION_CAPABILITY);
  const identity = `${sourceKey}\0${projectId}\0${path}\0${rev ?? ""}\0${origPath ?? ""}`;
  const [loaded, setLoaded] = useState<{
    identity: string;
    value: GitFileRevision | null;
  }>({ identity, value: null });
  const revision = loaded.identity === identity ? loaded.value : null;

  useEffect(() => {
    if (!supported || !projectId || !path) return;
    let cancelled = false;
    void api
      .getGitFileRevision(projectId, { path, rev, origPath })
      .then((value) => {
        if (!cancelled) setLoaded({ identity, value });
      })
      .catch(() => {
        if (!cancelled) setLoaded({ identity, value: null });
      });
    return () => {
      cancelled = true;
    };
  }, [identity, origPath, path, projectId, rev, supported]);

  if (!supported || !revision?.isGitRepo) return null;
  if (!revision.commit) {
    return (
      <span
        className={`${styles.root} ${styles.uncommitted} ${className ?? ""}`}
      >
        {uncommittedLabel}
      </span>
    );
  }

  const params = new URLSearchParams({
    projectId,
    rev: revision.commit.hash,
    commitFile: rev ? path : (origPath ?? path),
  });
  const href = toBrowserAppHref(`${basePath}/git-status?${params.toString()}`);
  const tooltip = formatRevisionTooltip(revision.commit);

  return (
    <span className={`${styles.root} ${className ?? ""}`}>
      <a className={styles.commit} href={href} title={tooltip}>
        {revision.commit.shortHash}
      </a>
      <span className={styles.age}>
        ({formatRevisionAge(revision.commit.authorDate)})
      </span>
      {revision.dirty && <span className={styles.dirty}>{dirtyLabel}</span>}
    </span>
  );
}

export function formatRevisionAge(
  authorDate: string,
  now = Date.now(),
): string {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((now - new Date(authorDate).getTime()) / 1000),
  );
  if (elapsedSeconds < 60) return "now";
  const minutes = Math.floor(elapsedSeconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

export function formatRevisionTooltip(commit: GitFileRevisionCommit): string {
  const absoluteTime = new Date(commit.authorDate).toLocaleString();
  const message = `${commit.message}${commit.messageTruncated ? "\n..." : ""}`;
  return `${commit.authorName}\n${absoluteTime}\n\n${message}`;
}
