import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { beginTooltipSuppression } from "../hooks/useTooltipAppearance";
import { useI18n } from "../i18n";
import { useClientSummarySourceKey } from "../lib/clientSummaryStore";
import { isMarkdownLikeFile } from "../lib/markdownFiles";
import { setNewSessionPrefill } from "../lib/newSessionPrefill";
import styles from "./FileResourceActions.module.css";

export type FileViewPresentation = "preview" | "source";

export function supportsSourceAndPreview(
  filePath: string,
  renderMarkdown = false,
): boolean {
  return (
    renderMarkdown ||
    isMarkdownLikeFile(filePath) ||
    /\.(?:html?|xhtml)$/i.test(filePath)
  );
}

interface FilePathContextMenuProps {
  x: number;
  y: number;
  canStartNewSession?: boolean;
  onClose: () => void;
  onCopyAbsolutePath?: () => void;
  onCopyContents?: () => void;
  onCopyFilePath?: () => void;
  onCopyProjectRelativePath?: () => void;
  onCopyViewerLink?: () => void;
  onOpen: () => void;
  onOpenPreview?: () => void;
  onOpenSource?: () => void;
  onStartNewSession?: () => void;
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
  opensPanel = false,
}: {
  children: ReactNode;
  onSelect: () => void;
  opensPanel?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup={opensPanel ? "menu" : undefined}
      onClick={onSelect}
    >
      {children}
    </button>
  );
}

function BranchLabel({ children }: { children: ReactNode }) {
  return (
    <span className={styles.branchLabel}>
      <span>{children}</span>
      <span aria-hidden="true">›</span>
    </span>
  );
}

function BackLabel({ children }: { children: ReactNode }) {
  return (
    <span className={styles.backLabel}>
      <span aria-hidden="true">‹</span>
      <span>{children}</span>
    </span>
  );
}

export function FilePathContextMenu({
  x,
  y,
  canStartNewSession = true,
  onClose,
  onCopyAbsolutePath,
  onCopyContents,
  onCopyFilePath,
  onCopyProjectRelativePath,
  onCopyViewerLink,
  onOpen,
  onOpenPreview,
  onOpenSource,
  onStartNewSession,
}: FilePathContextMenuProps) {
  const { t } = useI18n();
  const [panel, setPanel] = useState<"copy" | "open" | "root">("root");
  const hasPresentationChoice = Boolean(onOpenSource && onOpenPreview);
  const hasCopyActions = Boolean(
    onCopyProjectRelativePath ||
      onCopyAbsolutePath ||
      onCopyFilePath ||
      onCopyViewerLink ||
      onCopyContents,
  );

  // The right-click that opened this menu came from a link that was almost
  // certainly showing its hover tooltip, and the pointer then holds still — so
  // without this the tooltip sits over the menu's first entries until the
  // reader moves far enough to shake it off.
  useEffect(() => beginTooltipSuppression(), []);

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

  const estimatedMenuHeight = panel === "copy" ? 280 : 180;

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
          left: Math.max(8, Math.min(x, window.innerWidth - 230)),
          top: Math.max(
            8,
            Math.min(y, window.innerHeight - estimatedMenuHeight),
          ),
        }}
      >
        {panel === "root" ? (
          <>
            <FilePathContextMenuItem
              opensPanel={hasPresentationChoice}
              onSelect={() =>
                hasPresentationChoice ? setPanel("open") : select(onOpen)
              }
            >
              {hasPresentationChoice ? (
                <BranchLabel>{t("fileLinkMenuOpen" as never)}</BranchLabel>
              ) : (
                t("fileLinkMenuOpen" as never)
              )}
            </FilePathContextMenuItem>
            {canStartNewSession && onStartNewSession ? (
              <FilePathContextMenuItem
                onSelect={() => select(onStartNewSession)}
              >
                {t("fileLinkMenuNewSession" as never)}
              </FilePathContextMenuItem>
            ) : null}
            {hasCopyActions ? <div className={styles.separator} /> : null}
            {hasCopyActions ? (
              <FilePathContextMenuItem
                opensPanel
                onSelect={() => setPanel("copy")}
              >
                <BranchLabel>{t("fileLinkMenuCopy" as never)}</BranchLabel>
              </FilePathContextMenuItem>
            ) : null}
          </>
        ) : null}
        {panel === "open" ? (
          <>
            <FilePathContextMenuItem onSelect={() => setPanel("root")}>
              <BackLabel>{t("fileLinkMenuBack" as never)}</BackLabel>
            </FilePathContextMenuItem>
            <div className={styles.separator} />
            {onOpenSource ? (
              <FilePathContextMenuItem onSelect={() => select(onOpenSource)}>
                {t("fileViewerSource" as never)}
              </FilePathContextMenuItem>
            ) : null}
            {onOpenPreview ? (
              <FilePathContextMenuItem onSelect={() => select(onOpenPreview)}>
                {t("fileViewerPreview" as never)}
              </FilePathContextMenuItem>
            ) : null}
          </>
        ) : null}
        {panel === "copy" ? (
          <>
            <FilePathContextMenuItem onSelect={() => setPanel("root")}>
              <BackLabel>{t("fileLinkMenuBack" as never)}</BackLabel>
            </FilePathContextMenuItem>
            <div className={styles.separator} />
            {onCopyProjectRelativePath ? (
              <FilePathContextMenuItem
                onSelect={() => select(onCopyProjectRelativePath)}
              >
                {t("fileLinkMenuProjectRelativePath" as never)}
              </FilePathContextMenuItem>
            ) : null}
            {onCopyAbsolutePath ? (
              <FilePathContextMenuItem
                onSelect={() => select(onCopyAbsolutePath)}
              >
                {t("fileLinkMenuAbsolutePath" as never)}
              </FilePathContextMenuItem>
            ) : null}
            {onCopyFilePath ? (
              <FilePathContextMenuItem onSelect={() => select(onCopyFilePath)}>
                {t("fileLinkMenuFilePath" as never)}
              </FilePathContextMenuItem>
            ) : null}
            {onCopyViewerLink ? (
              <FilePathContextMenuItem
                onSelect={() => select(onCopyViewerLink)}
              >
                {t("fileLinkMenuViewerLink" as never)}
              </FilePathContextMenuItem>
            ) : null}
            {onCopyContents ? (
              <FilePathContextMenuItem onSelect={() => select(onCopyContents)}>
                {t("fileLinkMenuContents" as never)}
              </FilePathContextMenuItem>
            ) : null}
          </>
        ) : null}
      </div>
    </>,
    document.body,
  );
}
