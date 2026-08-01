import type { ReactNode } from "react";
import { useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { setNewSessionPrefill } from "../lib/newSessionPrefill";
import styles from "./FileResourceActions.module.css";

interface FilePathContextMenuProps {
  x: number;
  y: number;
  canCopyContents?: boolean;
  canStartNewSession?: boolean;
  onClose: () => void;
  onCopyContents?: () => void;
  onCopyPath: () => void;
  onCopyUrl?: () => void;
  onStartNewSession?: () => void;
  onView: () => void;
}

export function useStartNewSessionFromFileAction() {
  const basePath = useRemoteBasePath();
  const clientSummarySourceKey = useClientSummarySourceKey();

  return useCallback(
    (projectId: string, filePath: string) => {
      const trimmed = filePath.trim();
      if (!projectId || !trimmed) return;
      setNewSessionPrefill(clientSummarySourceKey, trimmed);
      const url = `${basePath}/new-session?projectId=${encodeURIComponent(projectId)}`;
      window.history.pushState(window.history.state, "", url);
      const navigationEvent =
        typeof PopStateEvent === "function"
          ? new PopStateEvent("popstate", { state: window.history.state })
          : new Event("popstate");
      window.dispatchEvent(navigationEvent);
    },
    [basePath, clientSummarySourceKey],
  );
}

export function useStartNewSessionFromFile(
  projectId: string,
  filePath: string,
) {
  const startNewSession = useStartNewSessionFromFileAction();
  return useCallback(() => {
    startNewSession(projectId, filePath);
  }, [filePath, projectId, startNewSession]);
}

function FilePathContextMenuItem({
  children,
  onSelect,
}: {
  children: ReactNode;
  onSelect: () => void;
}) {
  return (
    <button type="button" role="menuitem" onClick={onSelect}>
      {children}
    </button>
  );
}

export function FilePathContextMenu({
  x,
  y,
  canCopyContents = true,
  canStartNewSession = true,
  onClose,
  onCopyContents,
  onCopyPath,
  onCopyUrl,
  onStartNewSession,
  onView,
}: FilePathContextMenuProps) {
  const { t } = useI18n();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const select = (action: () => void) => {
    action();
    onClose();
  };

  return createPortal(
    <>
      <button
        type="button"
        className={styles.overlay}
        aria-label={t("fileLinkDismissMenu" as never)}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      <div
        className={styles.menu}
        role="menu"
        style={{
          left: Math.max(8, Math.min(x, window.innerWidth - 190)),
          top: Math.max(8, Math.min(y, window.innerHeight - 180)),
        }}
      >
        <FilePathContextMenuItem onSelect={() => select(onView)}>
          {t("fileLinkMenuView" as never)}
        </FilePathContextMenuItem>
        {canStartNewSession && onStartNewSession ? (
          <FilePathContextMenuItem onSelect={() => select(onStartNewSession)}>
            {t("fileLinkMenuNewSession" as never)}
          </FilePathContextMenuItem>
        ) : null}
        {onCopyUrl ? (
          <FilePathContextMenuItem onSelect={() => select(onCopyUrl)}>
            {t("fileLinkMenuCopyUrl" as never)}
          </FilePathContextMenuItem>
        ) : null}
        <FilePathContextMenuItem onSelect={() => select(onCopyPath)}>
          {t("fileLinkMenuCopyPath" as never)}
        </FilePathContextMenuItem>
        {canCopyContents && onCopyContents ? (
          <FilePathContextMenuItem onSelect={() => select(onCopyContents)}>
            {t("fileLinkMenuCopyContents" as never)}
          </FilePathContextMenuItem>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
