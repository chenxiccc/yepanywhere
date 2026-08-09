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

export interface ResourceContextMenuProps {
  x: number;
  y: number;
  canStartNewSession?: boolean;
  dismissLabel?: string;
  onClose: () => void;
  onCopyAbsolutePath?: () => void;
  onCopyContents?: () => void;
  onCopyFilePath?: () => void;
  onCopyImage?: () => void;
  onCopyProjectRelativePath?: () => void;
  onCopyViewerLink?: () => void;
  onDownload?: () => void;
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
  expanded = false,
  onHover,
  onSelect,
  opensPanel = false,
}: {
  children: ReactNode;
  expanded?: boolean;
  onHover?: () => void;
  onSelect: () => void;
  opensPanel?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-haspopup={opensPanel ? "menu" : undefined}
      aria-expanded={opensPanel ? expanded : undefined}
      className={expanded ? styles.activeItem : undefined}
      onClick={onSelect}
      onMouseEnter={onHover}
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

export function ResourceContextMenu({
  x,
  y,
  canStartNewSession = true,
  dismissLabel,
  onClose,
  onCopyAbsolutePath,
  onCopyContents,
  onCopyFilePath,
  onCopyImage,
  onCopyProjectRelativePath,
  onCopyViewerLink,
  onDownload,
  onOpen,
  onOpenPreview,
  onOpenSource,
  onStartNewSession,
}: ResourceContextMenuProps) {
  const { t } = useI18n();
  const [panel, setPanel] = useState<"copy" | "open" | "root">("root");
  const hasPresentationChoice = Boolean(onOpenSource && onOpenPreview);
  const hasCopyActions = Boolean(
    onCopyProjectRelativePath ||
      onCopyAbsolutePath ||
      onCopyFilePath ||
      onCopyImage ||
      onCopyViewerLink ||
      onCopyContents,
  );
  const usesHoverFlyout =
    window.innerWidth >= 520 &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  // The right-click that opened this menu came from a link that was almost
  // certainly showing its hover tooltip, and the pointer then holds still — so
  // without this the tooltip sits over the menu's first entries until the
  // reader moves far enough to shake it off.
  useEffect(() => beginTooltipSuppression(), []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  const select = (action: () => void) => {
    action();
    onClose();
  };

  const rootMenuLeft = Math.max(8, Math.min(x, window.innerWidth - 230));
  const rootMenuHeight = onDownload ? 220 : 180;
  const rootMenuTop = Math.max(
    8,
    Math.min(y, window.innerHeight - rootMenuHeight),
  );
  const estimatedSubmenuHeight =
    panel === "copy" ? 280 + (onCopyImage ? 44 : 0) : 180;
  const submenuTop = usesHoverFlyout
    ? Math.max(
        8,
        Math.min(rootMenuTop, window.innerHeight - estimatedSubmenuHeight),
      )
    : Math.max(8, Math.min(y, window.innerHeight - estimatedSubmenuHeight));
  const canOpenSubmenuRight = rootMenuLeft + 218 + 230 <= window.innerWidth;
  const submenuLeft = usesHoverFlyout
    ? canOpenSubmenuRight
      ? rootMenuLeft + 218
      : Math.max(8, rootMenuLeft - 218)
    : rootMenuLeft;
  const renderRootPanel = panel === "root" || usesHoverFlyout;

  return createPortal(
    <>
      <button
        type="button"
        className={styles.overlay}
        aria-label={dismissLabel ?? t("fileLinkDismissMenu" as never)}
        onClick={onClose}
        onContextMenu={(event) => {
          event.preventDefault();
          onClose();
        }}
      />
      {renderRootPanel ? (
        <div
          className={styles.menu}
          role="menu"
          style={{ left: rootMenuLeft, top: rootMenuTop }}
        >
          <FilePathContextMenuItem
            expanded={panel === "open"}
            opensPanel={hasPresentationChoice}
            onHover={
              usesHoverFlyout && hasPresentationChoice
                ? () => setPanel("open")
                : undefined
            }
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
          {onDownload ? (
            <FilePathContextMenuItem
              onHover={usesHoverFlyout ? () => setPanel("root") : undefined}
              onSelect={() => select(onDownload)}
            >
              {t("resourceMenuDownload" as never)}
            </FilePathContextMenuItem>
          ) : null}
          {canStartNewSession && onStartNewSession ? (
            <FilePathContextMenuItem
              onHover={usesHoverFlyout ? () => setPanel("root") : undefined}
              onSelect={() => select(onStartNewSession)}
            >
              {t("fileLinkMenuNewSession" as never)}
            </FilePathContextMenuItem>
          ) : null}
          {hasCopyActions ? <div className={styles.separator} /> : null}
          {hasCopyActions ? (
            <FilePathContextMenuItem
              expanded={panel === "copy"}
              opensPanel
              onHover={usesHoverFlyout ? () => setPanel("copy") : undefined}
              onSelect={() => setPanel("copy")}
            >
              <BranchLabel>{t("fileLinkMenuCopy" as never)}</BranchLabel>
            </FilePathContextMenuItem>
          ) : null}
        </div>
      ) : null}
      {panel !== "root" ? (
        <div
          aria-label={
            panel === "open"
              ? t("fileLinkMenuOpen" as never)
              : t("fileLinkMenuCopy" as never)
          }
          className={`${styles.menu} ${styles.submenu}`}
          role="menu"
          style={{ left: submenuLeft, top: submenuTop }}
        >
          {!usesHoverFlyout ? (
            <>
              <FilePathContextMenuItem onSelect={() => setPanel("root")}>
                <BackLabel>{t("fileLinkMenuBack" as never)}</BackLabel>
              </FilePathContextMenuItem>
              <div className={styles.separator} />
            </>
          ) : null}
          {panel === "open" ? (
            <>
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
              {onCopyImage ? (
                <FilePathContextMenuItem onSelect={() => select(onCopyImage)}>
                  {t("imageResourceMenuImage" as never)}
                </FilePathContextMenuItem>
              ) : null}
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
                <FilePathContextMenuItem
                  onSelect={() => select(onCopyFilePath)}
                >
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
                <FilePathContextMenuItem
                  onSelect={() => select(onCopyContents)}
                >
                  {t("fileLinkMenuContents" as never)}
                </FilePathContextMenuItem>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </>,
    document.body,
  );
}

/** File-oriented compatibility name for existing call sites. */
export const FilePathContextMenu = ResourceContextMenu;
