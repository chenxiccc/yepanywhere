import type {
  GitCommitDetail,
  GitFileChange,
  GitRecentCommit,
} from "@yep-anywhere/shared";
import type { ReactNode, RefObject } from "react";
import { CopyButton } from "../components/CopyButton";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
} from "../components/SourceFileRow";
import {
  SourceRowMenuTrigger,
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { handleSourceListKeyDown } from "../hooks/useSourceKeyboard";
import { writeClipboardText } from "../lib/clipboard";
import { reflowCommitMessage } from "../lib/reflowCommitMessage";
import type { TranslationFn } from "../i18n";

/**
 * Selected revision's files pane. It owns the revision banner, changed-file
 * list, and file menus; diff rendering stays in the adjacent detail pane.
 */
export function CommitFilesPane({
  columnRef,
  selectedSha,
  selectedCommit,
  detail,
  loading,
  detailError,
  compareToHead,
  isWideScreen,
  messageView,
  selectedFiles,
  selectedPath,
  fileCommentCount,
  revisionNavigation,
  onBack,
  onToggleComparison,
  onShowMessage,
  onFocusFile,
  onActivateFile,
  onBlameFile,
  onMarkReadTo,
  onMarkUnreadSince,
  t,
}: {
  columnRef: RefObject<HTMLDivElement | null>;
  selectedSha: string;
  selectedCommit?: GitRecentCommit;
  detail: GitCommitDetail | null;
  loading: boolean;
  detailError: string | null;
  compareToHead: boolean;
  isWideScreen: boolean;
  messageView: boolean;
  selectedFiles: GitFileChange[];
  selectedPath: string | null;
  fileCommentCount: ReadonlyMap<string, number>;
  revisionNavigation: ReactNode;
  onBack?: () => void;
  onToggleComparison: () => void;
  onShowMessage: () => void;
  onFocusFile: (file: GitFileChange) => void;
  onActivateFile: (file: GitFileChange) => void;
  onBlameFile?: (path: string) => void;
  onMarkReadTo: (authorDate: string) => void;
  onMarkUnreadSince: (authorDate: string) => void;
  t: TranslationFn;
}) {
  const fileMenu = useSourceContextMenu(t);
  const fileMenuActions = (file: GitFileChange): SourceContextMenuAction[] => [
    {
      label: t("sourceCopyPath"),
      onSelect: () => {
        void writeClipboardText(file.path);
      },
    },
    ...(onBlameFile
      ? [
          {
            label: t("sourceBlameAtHead"),
            onSelect: () => onBlameFile(file.path),
          },
        ]
      : []),
  ];

  return (
    <>
      <div className="commit-files-column" ref={columnRef}>
        {onBack && (
          <button
            type="button"
            className="source-mobile-back"
            onClick={onBack}
          >
            ← {t("sourceBackToCommits")}
          </button>
        )}
        <div className="source-detail-banner">
          {revisionNavigation}
          <span className="source-detail-identity">
            <span
              className="source-detail-subject"
              title={detail?.subject ?? selectedCommit?.subject}
            >
              {detail?.subject ?? selectedCommit?.subject ?? "…"}
            </span>
            <span
              className="source-detail-title"
              title={
                selectedCommit
                  ? `${selectedCommit.hash}\n${formatCommitDateTime(
                      selectedCommit.authorDate,
                    )}`
                  : selectedSha
              }
            >
              {detail?.shortHash ?? selectedCommit?.shortHash ?? "…"}
            </span>
          </span>
          <button
            type="button"
            className={`source-detail-action source-compare-toggle ${
              compareToHead ? "active" : ""
            }`}
            title={t("sourceCompareToHeadDescription")}
            aria-pressed={compareToHead}
            onClick={onToggleComparison}
          >
            {t("sourceCompareToHead")}
          </button>
          <CopyButton
            value={selectedSha}
            title={t("sourceCopyCommitHash")}
            className="source-detail-action"
          />
          <button
            type="button"
            className="source-detail-action source-detail-icon-action"
            title={t("sourceMarkReadToHere")}
            aria-label={t("sourceMarkReadToHere")}
            disabled={!selectedCommit}
            onClick={() =>
              selectedCommit && onMarkReadTo(selectedCommit.authorDate)
            }
          >
            <EyeIcon />
            <span className="source-detail-action-text">
              {t("sourceMarkReadToHere")}
            </span>
          </button>
          <button
            type="button"
            className="source-detail-action source-detail-icon-action"
            title={t("sourceMarkUnreadSinceHere")}
            aria-label={t("sourceMarkUnreadSinceHere")}
            disabled={!selectedCommit}
            onClick={() =>
              selectedCommit && onMarkUnreadSince(selectedCommit.authorDate)
            }
          >
            <EyeIcon crossed />
            <span className="source-detail-action-text">
              {t("sourceMarkUnreadSinceHere")}
            </span>
          </button>
        </div>
        {loading ? (
          <div className="git-diff-loading">{t("gitStatusLoading")}</div>
        ) : detailError ? (
          <div className="git-diff-error">{detailError}</div>
        ) : detail ? (
          <>
            {detail.body && (
              <button
                type="button"
                className={`commit-body ${
                  !isWideScreen ? "commit-body-mobile" : ""
                } ${messageView ? "selected" : ""}`}
                title={t("sourceShowFullMessage")}
                onClick={onShowMessage}
              >
                {isWideScreen
                  ? reflowCommitMessage(detail.body)
                  : t("sourceShowFullMessage")}
              </button>
            )}
            <ul
              className="commit-file-list"
              onKeyDown={handleSourceListKeyDown}
            >
              {selectedFiles.map((file) => {
                const count = fileCommentCount.get(file.path) ?? 0;
                const isFolder = file.path.endsWith("/");
                const menuActions = fileMenuActions(file);
                const displayPath = file.origPath
                  ? `${file.origPath} → ${file.path}`
                  : file.path;
                return (
                  <li key={file.path} className="commit-file-row">
                    <SourceFileRowButton
                      path={displayPath}
                      type="button"
                      className={`commit-file-item ${
                        selectedPath === file.path ? "selected" : ""
                      }`}
                      disabled={isFolder}
                      data-source-list-item
                      onFocus={() => {
                        if (isWideScreen && !isFolder) onFocusFile(file);
                      }}
                      {...fileMenu.targetProps(menuActions, () => {
                        if (!isFolder) onActivateFile(file);
                      })}
                    >
                      <SourceFileStatusBadge status={file.status} t={t} />
                      <SourceFilePath>{displayPath}</SourceFilePath>
                      {(file.linesAdded !== null ||
                        file.linesDeleted !== null) && (
                        <span className="git-line-counts">
                          {file.linesAdded ? (
                            <span className="git-lines-added">
                              +{file.linesAdded}
                            </span>
                          ) : null}
                          {file.linesDeleted ? (
                            <span className="git-lines-deleted">
                              −{file.linesDeleted}
                            </span>
                          ) : null}
                        </span>
                      )}
                      {count > 0 && (
                        <span
                          className="source-comment-badge"
                          title={t("sourceCommentCount", { count })}
                        >
                          {count}
                        </span>
                      )}
                    </SourceFileRowButton>
                    {!isFolder && (
                      <SourceRowMenuTrigger
                        actions={menuActions}
                        label={t("sourceMoreActions")}
                        onOpen={fileMenu.openFromButton}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
            {selectedFiles.length === 0 && (
              <div className="git-status-empty">
                {compareToHead
                  ? t("sourceNoChangesToHead")
                  : t("sourceNoFiles")}
              </div>
            )}
          </>
        ) : null}
      </div>
      {fileMenu.menu}
    </>
  );
}

export function formatCommitDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function EyeIcon({ crossed = false }: { crossed?: boolean }) {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z" />
      <circle cx="12" cy="12" r="2.5" />
      {crossed && <path d="m4 4 16 16" />}
    </svg>
  );
}
