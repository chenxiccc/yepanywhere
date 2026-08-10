import { fromUrlProjectId, isUrlProjectId } from "@yep-anywhere/shared";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { api } from "../api/client";
import {
  buildPublicShareFileHref,
  usePublicShareContext,
} from "../contexts/PublicShareContext";
import { GlossaryProjectBoundary } from "../contexts/GlossaryContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useTextTooltipAttributes } from "../hooks/useTooltipAppearance";
import { toBrowserAppHref } from "../lib/appHref";
import { writeClipboardText, writeClipboardTextLater } from "../lib/clipboard";
import { QUOTE_SELECTION_ROOT_ATTRIBUTES } from "../lib/markdownSelectionCopy";
import {
  getAbsoluteFilePath,
  getPathBasename,
  getProjectRelativePath,
  isAbsoluteLikePath,
  normalizePathSeparators,
  stripTrailingPathSeparators,
} from "../lib/text";
import {
  FileViewer,
  type FileViewerMode,
  type FileViewerSource,
} from "./FileViewer";
import {
  buildProjectFileViewUrl,
  FileVersionControlLinks,
} from "./FileDiffViewLinks";
import {
  FilePathContextMenu,
  type FileViewPresentation,
  supportsSourceAndPreview,
  useStartNewSessionFromFile,
} from "./FileResourceActions";
import { createPublicShareFileViewerSource } from "./publicShareFileViewerSource";
import { CopyTextButton } from "./ui/CopyTextButton";
import { useModalBackGesture } from "./ui/Modal";
import styles from "./FilePathLink.module.css";

export { FileVersionControlLinks } from "./FileDiffViewLinks";

/**
 * Faint copy-to-clipboard affordance rendered after a pathname. Copies the
 * project-relative path when the file is under the project (paste-safe at
 * the repo root), the path verbatim otherwise; no line suffix either way —
 * drag-selecting the text of a clickable link is fiddly. Click must not
 * bubble: path links live inside tool rows whose row click toggles expansion.
 */
export function FilePathCopyButton({ filePath }: { filePath: string }) {
  return (
    <CopyTextButton
      text={filePath}
      label="Copy path"
      copiedLabel="Copied path"
      className="file-path-copy"
      onClick={(event) => event.stopPropagation()}
    />
  );
}

interface FilePathLinkProps {
  /** The file path to display and link to */
  filePath: string;
  /** Project ID for fetching file content */
  projectId: string;
  /** Optional line number to display */
  lineNumber?: number;
  /** Optional end line for range highlighting */
  lineEnd?: number;
  /** Optional column number to display */
  columnNumber?: number;
  /** Optional custom display text (defaults to filename) */
  displayText?: string;
  /** Whether to append the line/range suffix to the visible link text */
  showLineSuffix?: boolean;
  /** Whether to show full path or just filename */
  showFullPath?: boolean;
  /** Viewer mode. The range mode shows only the requested line range. */
  viewMode?: FileViewerMode;
  /** Whether to render the faint copy-path button after the link */
  showCopyButton?: boolean;
}

function getProjectPath(projectId: string): string | null {
  if (!isUrlProjectId(projectId)) {
    return null;
  }
  try {
    const projectPath = fromUrlProjectId(projectId);
    return stripTrailingPathSeparators(projectPath);
  } catch {
    return null;
  }
}

function getProjectViewerFilePath(projectId: string, filePath: string): string {
  const projectPath = getProjectPath(projectId);
  const projectRelativePath = getProjectRelativePath(filePath, projectPath);
  if (projectRelativePath !== null) {
    return projectRelativePath;
  }

  const normalizedPath = normalizePathSeparators(filePath);
  const isAbsolutePath =
    normalizedPath.startsWith("/") || /^[a-zA-Z]:\//.test(normalizedPath);
  return !isAbsolutePath && filePath.includes("\\")
    ? normalizePathSeparators(filePath)
    : filePath;
}

function formatLineSuffix(lineNumber?: number, lineEnd?: number): string {
  if (lineNumber === undefined) {
    return "";
  }
  if (lineEnd !== undefined && lineEnd > lineNumber) {
    return `:${lineNumber}-${lineEnd}`;
  }
  return `:${lineNumber}`;
}

/**
 * FilePathLink - A clickable link component that opens a file viewer modal.
 * Used to make file paths in messages interactive.
 */
export const FilePathLink = memo(function FilePathLink({
  filePath,
  projectId,
  lineNumber,
  lineEnd,
  columnNumber,
  displayText,
  showLineSuffix = true,
  showFullPath = false,
  viewMode = "full",
  showCopyButton = true,
}: FilePathLinkProps) {
  const publicShareContext = usePublicShareContext();
  const basePath = useRemoteBasePath();
  const [showModal, setShowModal] = useState(false);
  const [modalPresentation, setModalPresentation] =
    useState<FileViewPresentation>();
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const viewerFilePath = useMemo(
    () => getProjectViewerFilePath(projectId, filePath),
    [projectId, filePath],
  );
  const startNewSession = useStartNewSessionFromFile(projectId, viewerFilePath);
  const projectPath = useMemo(() => getProjectPath(projectId), [projectId]);
  const projectRelativeCopyPath = useMemo(
    () =>
      isAbsoluteLikePath(viewerFilePath)
        ? getProjectRelativePath(viewerFilePath, projectPath)
        : normalizePathSeparators(viewerFilePath).replace(/^\.\/+/, ""),
    [projectPath, viewerFilePath],
  );
  const absoluteCopyPath = useMemo(() => {
    return getAbsoluteFilePath(
      isAbsoluteLikePath(filePath) ? filePath : viewerFilePath,
      projectPath,
    );
  }, [filePath, projectPath, viewerFilePath]);
  const hasPresentationChoice = supportsSourceAndPreview(viewerFilePath);
  const publicShareFileViewUrl = publicShareContext
    ? buildPublicShareFileHref(publicShareContext, {
        columnNumber,
        filePath: viewerFilePath,
        lineEnd,
        lineNumber,
        viewMode,
      })
    : null;
  const fileViewUrl =
    publicShareContext !== null
      ? publicShareFileViewUrl
      : toBrowserAppHref(
          buildProjectFileViewUrl({
            basePath,
            filePath: viewerFilePath,
            lineEnd,
            lineNumber,
            projectId,
            viewMode,
          }),
        );
  const publicShareFileViewerSource = useMemo(
    () =>
      publicShareContext
        ? createPublicShareFileViewerSource(publicShareContext)
        : undefined,
    [publicShareContext],
  );

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) {
        return;
      }
      if (publicShareContext && !publicShareFileViewUrl) {
        e.preventDefault();
        return;
      }
      e.preventDefault();
      setModalPresentation(undefined);
      setShowModal(true);
    },
    [publicShareContext, publicShareFileViewUrl],
  );

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);
  const handleContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  }, []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  const openFromMenu = useCallback((presentation?: FileViewPresentation) => {
    setModalPresentation(presentation);
    setShowModal(true);
  }, []);
  const handleCopyViewerLinkFromMenu = useCallback(() => {
    if (!fileViewUrl) return;
    void writeClipboardText(new URL(fileViewUrl, window.location.href).href);
  }, [fileViewUrl]);
  const handleCopyContentsFromMenu = useCallback(() => {
    const loadFile = publicShareFileViewerSource
      ? publicShareFileViewerSource.loadFile(projectId, viewerFilePath, false)
      : api.getFile(projectId, viewerFilePath);
    void writeClipboardTextLater(loadFile.then((file) => file.content ?? ""));
  }, [projectId, publicShareFileViewerSource, viewerFilePath]);

  // Format the display text
  const fileName = showFullPath ? filePath : getPathBasename(filePath);
  const text = displayText || fileName;

  const lineSuffix = formatLineSuffix(lineNumber, lineEnd);
  const columnSuffix =
    lineSuffix && columnNumber !== undefined && lineEnd === undefined
      ? `:${columnNumber}`
      : "";
  const suffix = `${lineSuffix}${columnSuffix}`;
  const visibleSuffix = showLineSuffix ? suffix : "";
  const tooltipAttributes = useTextTooltipAttributes(`${filePath}${suffix}`);

  return (
    <>
      <span className={styles.linkCluster}>
        <a
          href={fileViewUrl ?? "#"}
          className="file-path-link"
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          {...tooltipAttributes}
        >
          <span className="file-path-link-name">{text}</span>
          {visibleSuffix && (
            <span className="file-path-link-line">{visibleSuffix}</span>
          )}
        </a>
        {showCopyButton && <FilePathCopyButton filePath={viewerFilePath} />}
        {publicShareContext === null && (
          <FileVersionControlLinks
            className={styles.inlineDiffLinks}
            projectId={projectId}
            filePath={viewerFilePath}
          />
        )}
      </span>
      {contextMenu && (
        <FilePathContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canStartNewSession={publicShareContext === null}
          onClose={closeContextMenu}
          onOpen={() => openFromMenu()}
          onOpenSource={
            hasPresentationChoice ? () => openFromMenu("source") : undefined
          }
          onOpenPreview={
            hasPresentationChoice ? () => openFromMenu("preview") : undefined
          }
          onStartNewSession={startNewSession}
          onCopyProjectRelativePath={
            projectRelativeCopyPath
              ? () => void writeClipboardText(projectRelativeCopyPath)
              : undefined
          }
          onCopyAbsolutePath={
            publicShareContext === null && absoluteCopyPath
              ? () => void writeClipboardText(absoluteCopyPath)
              : undefined
          }
          onCopyFilePath={
            !projectRelativeCopyPath && !absoluteCopyPath
              ? () => void writeClipboardText(viewerFilePath)
              : undefined
          }
          onCopyViewerLink={
            fileViewUrl ? handleCopyViewerLinkFromMenu : undefined
          }
          onCopyContents={handleCopyContentsFromMenu}
        />
      )}
      {showModal && (
        <FileViewerModal
          projectId={projectId}
          filePath={viewerFilePath}
          lineNumber={lineNumber}
          lineEnd={lineEnd}
          viewMode={viewMode}
          initialPresentation={modalPresentation}
          source={publicShareFileViewerSource}
          openInNewTabUrl={fileViewUrl}
          onClose={handleClose}
        />
      )}
    </>
  );
});

/**
 * Modal wrapper for FileViewer.
 */
export function FileViewerModal({
  projectId,
  filePath,
  lineNumber,
  lineEnd,
  viewMode = "full",
  initialPresentation,
  source,
  openInNewTabUrl,
  onClose,
}: {
  projectId: string;
  filePath: string;
  lineNumber?: number;
  lineEnd?: number;
  viewMode?: FileViewerMode;
  initialPresentation?: FileViewPresentation;
  source?: FileViewerSource;
  openInNewTabUrl?: string | null;
  onClose: () => void;
}) {
  const publicShareContext = usePublicShareContext();
  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) {
      onClose();
    }
  };

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [onClose]);

  useModalBackGesture(onClose, true, "__fileViewerModal");

  // Prevent body scroll when modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  const modalContent = (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click dismisses the modal; Escape is handled globally
    // biome-ignore lint/a11y/useKeyWithClickEvents: Escape key handled in useEffect, click is for overlay dismiss
    <div
      className="modal-overlay"
      onClick={handleOverlayClick}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: click only stops propagation, keyboard handled globally */}
      <dialog
        className={`modal file-viewer-modal ${
          viewMode === "range" ? "file-viewer-modal-compact" : ""
        }`}
        {...QUOTE_SELECTION_ROOT_ATTRIBUTES}
        open
        onClick={(e) => e.stopPropagation()}
      >
        <FileViewer
          projectId={projectId}
          filePath={filePath}
          lineNumber={lineNumber}
          lineEnd={lineEnd}
          viewMode={viewMode}
          initialPresentation={initialPresentation}
          source={source}
          openInNewTabUrl={openInNewTabUrl}
          onClose={onClose}
        />
      </dialog>
    </div>
  );

  return createPortal(
    publicShareContext ? (
      modalContent
    ) : (
      <GlossaryProjectBoundary projectId={projectId}>
        {modalContent}
      </GlossaryProjectBoundary>
    ),
    document.body,
  );
}
