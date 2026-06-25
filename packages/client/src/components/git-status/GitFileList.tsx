import type { GitFileChange } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n";
import { useLongPressContextMenu } from "../../hooks/useLongPressContextMenu";
import { ChevronDownIcon } from "./GitStatusIcons";
import { FileContextMenu } from "./FileContextMenu";
import type { FileContextMenuState } from "./FileContextMenu";
import { FilePathLabel, fileKey, formatGitStatusBadge } from "./utils";

export function GitFileActionsMenu({
  isOpen,
  onToggle,
  onClose,
  onDiscard,
  onStash,
  busyAction,
  disabled,
  t,
}: {
  isOpen: boolean;
  onToggle: () => void;
  onClose: () => void;
  onDiscard: () => void;
  onStash: () => void;
  busyAction: string | null;
  disabled: boolean;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (menuRef.current?.contains(target)) return;
      onClose();
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [isOpen, onClose]);

  return (
    <div className="git-file-actions" ref={menuRef}>
      <button
        type="button"
        className="git-file-actions-toggle"
        onClick={onToggle}
        aria-label={t("gitStatusFileActions")}
        aria-expanded={isOpen}
        aria-haspopup="menu"
        disabled={disabled}
      >
        <ChevronDownIcon />
      </button>
      {isOpen ? (
        <div className="git-file-actions-menu" role="menu">
          <button
            type="button"
            className="git-file-actions-menu-item"
            onClick={onDiscard}
            disabled={busyAction !== null}
            role="menuitem"
          >
            {t("gitStatusDiscardSelected")}
          </button>
          <button
            type="button"
            className="git-file-actions-menu-item"
            onClick={onStash}
            disabled={busyAction !== null}
            role="menuitem"
          >
            {busyAction === "stash"
              ? t("gitStatusLoading")
              : t("gitStatusStashSelected")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function GitFileSection({
  title,
  files,
  selectedFile,
  onFileClick,
  excludedCommitFileKeys,
  onToggleCommitFile,
  onSetCommitFiles,
  projectPath,
  onRenameFile,
  onDeleteFile,
}: {
  title: ReactNode;
  files: GitFileChange[];
  selectedFile: GitFileChange | null;
  onFileClick: (file: GitFileChange) => void;
  excludedCommitFileKeys: Set<string>;
  onToggleCommitFile: (file: GitFileChange) => void;
  onSetCommitFiles: (files: GitFileChange[], selected: boolean) => void;
  /** 项目根目录绝对路径 / Project root absolute path */
  projectPath?: string;
  /** 重命名文件回调 / Rename file callback */
  onRenameFile?: (path: string, name: string) => void;
  /** 删除文件回调 / Delete file callback */
  onDeleteFile?: (path: string, name: string, isDirectory: boolean) => void;
}) {
  const { t } = useI18n();
  const selectAllRef = useRef<HTMLInputElement>(null);
  const selectedCount = files.filter(
    (file) => !excludedCommitFileKeys.has(fileKey(file)),
  ).length;
  const allSelected = selectedCount === files.length;
  const partiallySelected = selectedCount > 0 && selectedCount < files.length;
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  useEffect(() => {
    if (!selectAllRef.current) return;
    selectAllRef.current.indeterminate = partiallySelected;
  }, [partiallySelected]);

  return (
    <div className="git-file-section">
      <h3 className="git-file-section-title">
        <input
          ref={selectAllRef}
          type="checkbox"
          className="git-file-section-checkbox"
          checked={allSelected}
          onChange={(event) => onSetCommitFiles(files, event.target.checked)}
          aria-label={t("globalSessionsSelectAll")}
        />
        <span>{title}</span>
      </h3>
      <ul className="git-file-list">
        {files.map((file) => {
          const isSelected =
            selectedFile !== null && fileKey(file) === fileKey(selectedFile);

          return (
            <GitFileItem
              key={fileKey(file)}
              file={file}
              selected={isSelected}
              commitSelected={!excludedCommitFileKeys.has(fileKey(file))}
              onClick={onFileClick}
              onToggleCommit={onToggleCommitFile}
              onContextMenu={setContextMenu}
            />
          );
        })}
      </ul>

      {projectPath && (
        <FileContextMenu
          menu={contextMenu}
          projectPath={projectPath}
          onClose={closeContextMenu}
          onRename={onRenameFile}
          onDelete={onDeleteFile}
          t={t as (key: string, vars?: Record<string, string | number>) => string}
        />
      )}
    </div>
  );
}

function GitFileItem({
  file,
  selected,
  commitSelected,
  onClick,
  onToggleCommit,
  onContextMenu,
}: {
  file: GitFileChange;
  selected: boolean;
  commitSelected: boolean;
  onClick: (file: GitFileChange) => void;
  onToggleCommit: (file: GitFileChange) => void;
  onContextMenu: (menu: FileContextMenuState) => void;
}) {
  const openContextMenu = useCallback(
    (x: number, y: number) => {
      onContextMenu({
        path: file.path,
        name: file.path.split("/").pop() ?? file.path,
        isDirectory: false,
        x,
        y,
        showFileOperations: false,
      });
    },
    [file.path, onContextMenu],
  );

  const {
    handleContextMenu,
    handleTouchStart,
    handleTouchMove,
    handleTouchEnd,
    wrapClick,
  } = useLongPressContextMenu(openContextMenu);

  const handleClick = wrapClick(() => onClick(file));

  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: keyboard nav not needed for file list
    <li
      className={`git-file-item git-file-item-clickable ${selected ? "git-file-item-selected" : ""} ${commitSelected ? "" : "git-file-item-commit-excluded"}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <input
        type="checkbox"
        className="git-file-item-checkbox"
        checked={commitSelected}
        onChange={() => onToggleCommit(file)}
        onClick={(event) => event.stopPropagation()}
        aria-label={
          file.origPath ? `${file.origPath} to ${file.path}` : file.path
        }
      />
      <span
        className={`git-status-badge git-status-${file.status.toLowerCase()}`}
      >
        {formatGitStatusBadge(file.status)}
      </span>
      <span className="git-file-path">
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
      {(file.linesAdded !== null || file.linesDeleted !== null) && (
        <span className="git-line-counts">
          {file.linesAdded !== null && file.linesAdded > 0 ? (
            <span className="git-lines-added">+{file.linesAdded}</span>
          ) : null}
          {file.linesDeleted !== null && file.linesDeleted > 0 ? (
            <span className="git-lines-deleted">-{file.linesDeleted}</span>
          ) : null}
        </span>
      )}
    </li>
  );
}
