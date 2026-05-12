import type { GitFileChange } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import type { useI18n } from "../../i18n";

type Translate = ReturnType<typeof useI18n>["t"];

export function fileKey(file: GitFileChange): string {
  return `${file.path}:${file.status}:${file.staged ? "staged" : "unstaged"}`;
}

export function formatGitStatusBadge(status: string): string {
  if (status === "?") return "A";
  return status;
}

export function formatRelativeTime(timestamp: string, t: Translate): string {
  const now = Date.now();
  const then = new Date(timestamp).getTime();
  const diffMs = now - then;
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  const diffMonths = Math.floor(diffDays / 30);
  const diffYears = Math.floor(diffDays / 365);

  if (diffMins < 1) return t("gitStatusRelativeNow");
  if (diffMins < 60) return t("gitStatusRelativeMinutes", { count: diffMins });
  if (diffHours < 24) return t("gitStatusRelativeHours", { count: diffHours });
  if (diffDays <= 30) return t("gitStatusRelativeDays", { count: diffDays });
  if (diffMonths < 12)
    return t("gitStatusRelativeMonths", { count: diffMonths });
  return t("gitStatusRelativeYears", { count: diffYears });
}

export function FilePathLabel({ path }: { path: string }) {
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) {
    return <span className="git-file-name">{path}</span>;
  }

  const dir = path.slice(0, lastSlash + 1);
  const name = path.slice(lastSlash + 1);

  return (
    <span className="git-file-path-parts">
      <span className="git-file-dir">{dir}</span>
      <span className="git-file-name">{name}</span>
    </span>
  );
}

export function FilePathTitle({ file }: { file: GitFileChange }) {
  return (
    <span className="git-preview-modal-title">
      {file.origPath ? (
        <>
          <FilePathLabel path={file.origPath} />
          <span className="git-file-path-arrow">→</span>
          <FilePathLabel path={file.path} />
        </>
      ) : (
        <FilePathLabel path={file.path} />
      )}
    </span>
  );
}

export function WithStatusBadge({
  file,
  children,
}: {
  file: GitFileChange;
  children: ReactNode;
}) {
  return (
    <>
      <span
        className={`git-status-badge git-status-${file.status.toLowerCase()}`}
      >
        {formatGitStatusBadge(file.status)}
      </span>
      {children}
    </>
  );
}
