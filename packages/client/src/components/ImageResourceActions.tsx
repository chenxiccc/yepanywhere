import { type MouseEvent, type ReactNode, useState } from "react";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { toBrowserAppHref } from "../lib/appHref";
import { writeClipboardText } from "../lib/clipboard";
import { downloadBlob, writeClipboardImageLater } from "../lib/imageActions";
import {
  getAbsoluteFilePath,
  getProjectRelativePath,
  isAbsoluteLikePath,
  normalizePathSeparators,
} from "../lib/text";
import { ResourceContextMenu } from "./FileResourceActions";

interface ImageResourceActionsOptions {
  fileName: string;
  filePath?: string | null;
  loadBlob?: () => Promise<Blob>;
  onOpen: () => void;
  projectPath?: string | null;
  viewerLink?: string | null;
}

interface ImagePathCoordinates {
  absolutePath: string | null;
  filePath: string | null;
  projectRelativePath: string | null;
}

export function getProjectImageViewerLink({
  basePath = "",
  projectId,
  projectRelativePath,
}: {
  basePath?: string;
  projectId?: string | null;
  projectRelativePath?: string | null;
}): string | null {
  if (!projectId || !projectRelativePath) return null;
  const searchParams = new URLSearchParams({ path: projectRelativePath });
  return toBrowserAppHref(
    `${basePath}/projects/${projectId}/file?${searchParams}`,
  );
}

export function getImagePathCoordinates({
  exposeAbsolutePath,
  filePath,
  projectPath,
}: {
  exposeAbsolutePath: boolean;
  filePath?: string | null;
  projectPath?: string | null;
}): ImagePathCoordinates {
  const trimmedPath = filePath?.trim() ?? "";
  if (!trimmedPath) {
    return {
      absolutePath: null,
      filePath: null,
      projectRelativePath: null,
    };
  }

  const projectRelativePath = isAbsoluteLikePath(trimmedPath)
    ? getProjectRelativePath(trimmedPath, projectPath)
    : normalizePathSeparators(trimmedPath).replace(/^\.\/+/, "");
  const absolutePath = exposeAbsolutePath
    ? getAbsoluteFilePath(trimmedPath, projectPath)
    : null;

  return {
    absolutePath,
    filePath:
      projectRelativePath === null &&
      absolutePath === null &&
      (exposeAbsolutePath || !isAbsoluteLikePath(trimmedPath))
        ? trimmedPath
        : null,
    projectRelativePath:
      projectRelativePath && projectRelativePath !== "."
        ? projectRelativePath
        : null,
  };
}

export function useImageResourceActions({
  fileName,
  filePath,
  loadBlob,
  onOpen,
  projectPath: projectPathOverride,
  viewerLink,
}: ImageResourceActionsOptions): {
  contextMenuElement: ReactNode;
  handleContextMenu: (event: MouseEvent<Element>) => void;
} {
  const { t } = useI18n();
  const publicShare = usePublicShareContext();
  const sessionMetadata = useOptionalSessionMetadata();
  const basePath = useRemoteBasePath();
  const projectPath =
    projectPathOverride === undefined
      ? sessionMetadata?.projectPath
      : projectPathOverride;
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const coordinates = getImagePathCoordinates({
    exposeAbsolutePath: publicShare === null,
    filePath,
    projectPath,
  });
  const stableViewerLink =
    viewerLink ??
    (publicShare === null
      ? getProjectImageViewerLink({
          basePath,
          projectId: sessionMetadata?.projectId,
          projectRelativePath: coordinates.projectRelativePath,
        })
      : null);

  const handleContextMenu = (event: MouseEvent<Element>) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({ x: event.clientX, y: event.clientY });
  };

  const contextMenuElement = contextMenu ? (
    <ResourceContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      canStartNewSession={false}
      dismissLabel={t("imageResourceDismissMenu" as never)}
      onClose={() => setContextMenu(null)}
      onOpen={onOpen}
      onDownload={
        loadBlob
          ? () => {
              void loadBlob()
                .then((blob) => downloadBlob(blob, fileName))
                .catch(() => {});
            }
          : undefined
      }
      onCopyImage={
        loadBlob
          ? () => {
              void writeClipboardImageLater(loadBlob());
            }
          : undefined
      }
      onCopyProjectRelativePath={
        coordinates.projectRelativePath
          ? () => void writeClipboardText(coordinates.projectRelativePath ?? "")
          : undefined
      }
      onCopyAbsolutePath={
        coordinates.absolutePath
          ? () => void writeClipboardText(coordinates.absolutePath ?? "")
          : undefined
      }
      onCopyFilePath={
        coordinates.filePath
          ? () => void writeClipboardText(coordinates.filePath ?? "")
          : undefined
      }
      onCopyViewerLink={
        stableViewerLink
          ? () =>
              void writeClipboardText(
                new URL(stableViewerLink, window.location.href).href,
              )
          : undefined
      }
    />
  ) : null;

  return { contextMenuElement, handleContextMenu };
}
