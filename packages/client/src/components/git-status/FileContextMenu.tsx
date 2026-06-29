/**
 * 通用文件右键菜单组件 / Universal file context menu component.
 *
 * 支持桌面右键和移动端长按触发，通过 createPortal 渲染到 document.body。
 * 在所有文件展示场景中复用（FileTree、GitFileList、GitCommitHistoryPane、GitStashPane）。
 * Supports desktop right-click and mobile long-press, rendered via createPortal.
 * Reused across all file display scenarios.
 */
import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { writeClipboardText } from "../../lib/clipboard";

export interface FileContextMenuState {
  /** 文件相对路径 / Relative file path */
  path: string;
  /** 文件名 / File name */
  name: string;
  /** 是否是文件夹 / Whether this is a directory */
  isDirectory: boolean;
  /** 触发点 X / Trigger X position */
  x: number;
  /** 触发点 Y / Trigger Y position */
  y: number;
  /** 是否显示重命名/删除（由调用方根据文件状态决定）/ Show rename/delete (decided by caller based on file status) */
  showFileOperations?: boolean;
}

export function FileContextMenu({
  menu,
  projectPath,
  onClose,
  onRename,
  onDelete,
  t,
}: {
  menu: FileContextMenuState | null;
  /** 项目根目录绝对路径，用于拼接绝对路径 / Project root absolute path */
  projectPath: string;
  onClose: () => void;
  onRename?: (path: string, name: string) => void;
  onDelete?: (path: string, name: string, isDirectory: boolean) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  // Escape 键关闭菜单 / Close menu on Escape key
  useEffect(() => {
    if (!menu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menu, onClose]);

  const handleCopyName = useCallback(async () => {
    if (!menu) return;
    await writeClipboardText(menu.name);
    onClose();
  }, [menu, onClose]);

  const handleCopyAbsolutePath = useCallback(async () => {
    if (!menu) return;
    const absolutePath = `${projectPath}/${menu.path}`;
    await writeClipboardText(absolutePath);
    onClose();
  }, [menu, projectPath, onClose]);

  const handleCopyRelativePath = useCallback(async () => {
    if (!menu) return;
    await writeClipboardText(menu.path);
    onClose();
  }, [menu, onClose]);

  const handleRename = useCallback(() => {
    if (!menu || !onRename) return;
    onRename(menu.path, menu.name);
    onClose();
  }, [menu, onRename, onClose]);

  const handleDelete = useCallback(() => {
    if (!menu || !onDelete) return;
    onDelete(menu.path, menu.name, menu.isDirectory);
    onClose();
  }, [menu, onDelete, onClose]);

  if (!menu) return null;

  // 边界检测：防止菜单溢出屏幕 / Boundary detection: prevent menu from overflowing screen
  const top = Math.min(menu.y, window.innerHeight - 240);
  const left = Math.min(menu.x, window.innerWidth - 180);

  return createPortal(
    <>
      {/* 透明遮罩层：点击关闭 / Transparent overlay: click to close */}
      <button
        type="button"
        className="file-context-overlay"
        aria-label={t("sourceManagerCloseContextMenu")}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      {/* 菜单 / Menu */}
      <div
        className="file-context-menu"
        role="menu"
        style={{
          top,
          left,
        }}
      >
        <button
          type="button"
          role="menuitem"
          onClick={handleCopyName}
        >
          {t("sourceManagerFileContextCopyName")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={handleCopyAbsolutePath}
        >
          {t("sourceManagerFileContextCopyAbsolutePath")}
        </button>
        <button
          type="button"
          role="menuitem"
          onClick={handleCopyRelativePath}
        >
          {t("sourceManagerFileContextCopyRelativePath")}
        </button>

        {menu.showFileOperations !== false && (
          <>
            <div className="file-context-menu-separator" />
            <button
              type="button"
              role="menuitem"
              onClick={handleRename}
            >
              {t("sourceManagerFileContextRename")}
            </button>
            <button
              type="button"
              role="menuitem"
              className="file-context-menu-danger"
              onClick={handleDelete}
            >
              {t("sourceManagerFileContextDelete")}
            </button>
          </>
        )}
      </div>
    </>,
    document.body,
  );
}