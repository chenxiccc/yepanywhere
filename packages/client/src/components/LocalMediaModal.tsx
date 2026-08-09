import {
  type LocalResourceAttributes,
  type LocalResourceMediaType,
  type LocalResourceRef,
  parseLocalResourceLink,
} from "@yep-anywhere/shared";
import {
  type MouseEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { api } from "../api/client";
import { usePublicShareContext } from "../contexts/PublicShareContext";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useInlineMedia } from "../hooks/useInlineMedia";
import { useRemoteBasePath } from "../hooks/useRemoteBasePath";
import { useI18n } from "../i18n";
import { writeClipboardText, writeClipboardTextLater } from "../lib/clipboard";
import { downloadBlob, writeClipboardImageLater } from "../lib/imageActions";
import { createScriptlessHtmlPreviewDocument } from "../lib/scriptlessHtmlPreview";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import { toSourceTransportApiPath } from "../lib/sourceTransportPaths";
import {
  getAbsoluteFilePath,
  getPathBasename,
  getProjectRelativePath,
  isAbsoluteLikePath,
  makeDisplayPath,
} from "../lib/text";
import type { SourceTransport } from "../lib/transport";
import {
  describeImageSizing,
  type ImageSizing,
  isVectorImage,
} from "../lib/vectorImageSizing";
import {
  FilePathContextMenu,
  type FileViewPresentation,
  supportsSourceAndPreview,
  useStartNewSessionFromFileAction,
} from "./FileResourceActions";
import {
  getImagePathCoordinates,
  getProjectImageViewerLink,
  useImageResourceActions,
} from "./ImageResourceActions";
import {
  ImageViewer,
  type ImageViewerNavigation,
  type ImageViewerNavigationInput,
} from "./ImageViewer";
import styles from "./LocalMediaModal.module.css";
import { Modal } from "./ui/Modal";

export interface LocalMediaSource {
  buildApiPath?: (path: string) => string | null;
  fetchBlob?: (
    path: string,
    apiPath: string,
    purpose: "inline" | "modal",
  ) => Promise<Blob>;
}

interface LocalMediaModalProps {
  path: string;
  /** Semantic source path. Null means the image has no filesystem identity. */
  filePath?: string | null;
  mediaType: LocalResourceMediaType;
  mediaSource?: LocalMediaSource;
  imageNavigation?: ImageViewerNavigation;
  onClose: () => void;
}

interface DisplayedLocalMedia {
  blob: Blob;
  fileName: string;
  filePath: string | null;
  imageNavigation?: Pick<ImageViewerNavigation, "count" | "current">;
  mediaType: LocalResourceMediaType;
  path: string;
  url: string;
  vector: boolean;
}

interface LocalFileModalProps {
  resource: LocalResourceRef;
  initialPresentation?: FileViewPresentation;
  onClose: () => void;
}

export interface LocalFileModalTarget {
  resource: LocalResourceRef;
  initialPresentation?: FileViewPresentation;
}

export interface ProjectFileModalTarget {
  projectId: string;
  filePath: string;
  lineNumber?: number;
  lineEnd?: number;
  initialPresentation?: FileViewPresentation;
}

interface ProjectContext {
  projectId: string;
  projectPath: string | null;
}

interface UseLocalResourceClickOptions {
  projectContext?: ProjectContext | null;
}

interface UseLocalResourceClickResult {
  modal: {
    path: string;
    mediaType: LocalResourceMediaType;
  } | null;
  localFileModal: LocalFileModalTarget | null;
  projectFileModal: ProjectFileModalTarget | null;
  closeModal: () => void;
  closeLocalFileModal: () => void;
  closeProjectFileModal: () => void;
  contextMenuElement: ReactNode;
  handleClick: (e: MouseEvent) => void;
  handleContextMenu: (e: MouseEvent) => void;
}

type LocalFileViewState =
  | { status: "loading" }
  | { status: "error"; error: string }
  | {
      status: "text";
      contentType: string;
      text: string;
    }
  | {
      status: "html";
      html: string;
    }
  | {
      status: "blob";
      contentType: string;
      objectUrl: string;
    };

function getFileName(path: string): string {
  return getPathBasename(path);
}

function normalizeResourceForProjectContext(
  resource: LocalResourceRef,
  projectContext: ProjectContext | null | undefined,
): ProjectFileModalTarget | null {
  if (resource.kind === "project-file" && resource.projectId) {
    return {
      filePath: resource.path,
      lineEnd: resource.lineEnd,
      lineNumber: resource.lineNumber,
      projectId: resource.projectId,
    };
  }

  if (resource.kind !== "local-file" || !projectContext) {
    return null;
  }

  const relativePath = getProjectRelativePath(
    resource.path,
    projectContext.projectPath,
  );
  if (!relativePath || relativePath === ".") {
    return null;
  }

  return {
    filePath: relativePath,
    lineEnd: resource.lineEnd,
    lineNumber: resource.lineNumber,
    projectId: projectContext.projectId,
  };
}

function localMediaApiPath(path: string): string {
  return `/api/local-image?path=${encodeURIComponent(path)}`;
}

function localResourceApiPath(
  resource: LocalResourceRef,
  renderMarkdown: boolean,
): string {
  if (resource.kind === "project-raw-file") {
    const params = new URLSearchParams({ path: resource.path });
    if (resource.download) {
      params.set("download", "true");
    }
    return `/api/projects/${encodeURIComponent(
      resource.projectId ?? "",
    )}/files/raw?${params.toString()}`;
  }

  const params = new URLSearchParams({ path: resource.path });
  if (resource.renderMarkdown && renderMarkdown) {
    params.set("render", "1");
  }
  if (resource.download) {
    params.set("download", "true");
  }
  if (resource.lineNumber !== undefined) {
    params.set("line", String(resource.lineNumber));
  }
  if (resource.columnNumber !== undefined) {
    params.set("column", String(resource.columnNumber));
  }
  return `/api/local-file?${params.toString()}`;
}

function isLocalMediaType(
  value: string | null,
): value is LocalResourceMediaType {
  return value === "image" || value === "video";
}

export async function fetchMediaBlob(
  apiPath: string,
  transport = getSourceRuntimeRegistry().getCurrentSourceRuntime().transport,
): Promise<Blob> {
  return transport.fetchBlob(toSourceTransportApiPath(apiPath));
}

function buildMediaApiPath(
  path: string,
  mediaSource?: LocalMediaSource,
): string | null {
  return mediaSource?.buildApiPath?.(path) ?? localMediaApiPath(path);
}

export async function fetchLocalMediaBlob(
  path: string,
  mediaSource: LocalMediaSource | undefined,
  purpose: "inline" | "modal",
  transport = getSourceRuntimeRegistry().getCurrentSourceRuntime().transport,
): Promise<Blob> {
  const apiPath = buildMediaApiPath(path, mediaSource);
  if (!apiPath) {
    throw new Error("Media is outside this view");
  }
  return mediaSource?.fetchBlob
    ? mediaSource.fetchBlob(path, apiPath, purpose)
    : fetchMediaBlob(apiPath, transport);
}

async function decodeImageUrl(url: string): Promise<void> {
  const image = new Image();
  image.src = url;

  if (typeof image.decode === "function") {
    await image.decode();
    return;
  }

  if (image.complete) {
    if (image.naturalWidth > 0) {
      return;
    }
    throw new Error("Failed to decode image");
  }

  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Failed to decode image"));
  });
}

async function fetchLocalResourceBlob(
  apiPath: string,
  transport: SourceTransport,
): Promise<Blob> {
  return transport.fetchBlob(toSourceTransportApiPath(apiPath));
}

function readBlobText(blob: Blob): Promise<string> {
  const text = (blob as Blob & { text?: () => Promise<string> }).text;
  if (typeof text === "function") {
    return text.call(blob);
  }

  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("Read failed"));
    reader.readAsText(blob);
  });
}

function normalizeContentType(contentType: string): string {
  return contentType.split(";")[0]?.trim().toLowerCase() ?? "";
}

function isHtmlContentType(contentType: string): boolean {
  return normalizeContentType(contentType) === "text/html";
}

function isPdfContentType(contentType: string): boolean {
  return normalizeContentType(contentType) === "application/pdf";
}

function isTextContentType(contentType: string): boolean {
  const normalized = normalizeContentType(contentType);
  return (
    normalized.startsWith("text/") ||
    normalized === "application/json" ||
    normalized === "application/x-ndjson" ||
    normalized === "application/xml" ||
    normalized === "application/yaml" ||
    normalized === "application/x-yaml" ||
    normalized === "application/toml" ||
    normalized === "application/x-toml"
  );
}

/**
 * The inline preview nodes are built imperatively, so their module classes are
 * resolved once into a finite map instead of being looked up by computed key.
 */
const inlinePreviewClass = {
  error: styles.inlineError ?? "",
  frame: styles.inlineFrame ?? "",
  frameVector: styles.inlineFrameVector ?? "",
  image: styles.inlineImage ?? "",
  imageButton: styles.inlineImageButton ?? "",
  loading: styles.inlineLoading ?? "",
  player: styles.inlinePlayer ?? "",
} as const;

function renderInlinePreview(
  target: HTMLElement,
  path: string,
  mediaType: LocalResourceMediaType,
  objectUrl: string,
  sizing: ImageSizing,
) {
  const frame = document.createElement("span");
  frame.className =
    sizing === "vector-unsized"
      ? `${inlinePreviewClass.frame} ${inlinePreviewClass.frameVector}`
      : inlinePreviewClass.frame;

  if (mediaType === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.muted = true;
    video.className = inlinePreviewClass.player;
    video.src = objectUrl;
    frame.append(video);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = inlinePreviewClass.imageButton;
    button.title = `Open ${getFileName(path)}`;
    button.setAttribute("aria-label", `Open ${getFileName(path)}`);
    button.dataset.localMediaPreviewTrigger = "true";

    const image = document.createElement("img");
    image.className = inlinePreviewClass.image;
    image.src = objectUrl;
    image.alt = getFileName(path);
    button.append(image);

    frame.append(button);
  }

  target.replaceChildren(frame);
}

/**
 * Modal for viewing local media files (images and videos).
 * Fetches the file via the local-image API with proper auth handling.
 */
export function LocalMediaModal({
  path,
  filePath,
  mediaType,
  mediaSource,
  imageNavigation,
  onClose,
}: LocalMediaModalProps) {
  const { t } = useI18n();
  const transport = useCurrentSourceRuntime().transport;
  const [displayedMedia, setDisplayedMedia] =
    useState<DisplayedLocalMedia | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [keyboardNavigationSequence, setKeyboardNavigationSequence] =
    useState(0);
  const displayedMediaRef = useRef(displayedMedia);
  displayedMediaRef.current = displayedMedia;
  const imageNavigationInputRef =
    useRef<ImageViewerNavigationInput>("controls");
  const imageNavigationRef = useRef(imageNavigation);
  imageNavigationRef.current = imageNavigation;
  const hasImageNavigation = Boolean(imageNavigation);
  const requestedImageCount = imageNavigation?.count;
  const requestedImageCurrent = imageNavigation?.current;
  const requestedFileName = getFileName(path);
  const semanticFilePath = filePath === undefined ? path : filePath;
  const openImageInNewTabLabel = t("fileViewerOpenImageNewTab" as never);

  useEffect(() => {
    let cancelled = false;
    let pendingObjectUrl: string | null = null;
    let transferredObjectUrl = false;
    setLoading(true);
    setError(null);

    void fetchLocalMediaBlob(path, mediaSource, "modal", transport)
      .then(async (blob) => {
        if (cancelled) return;
        pendingObjectUrl = URL.createObjectURL(blob);
        if (mediaType === "image" && displayedMediaRef.current) {
          await decodeImageUrl(pendingObjectUrl);
        }
        if (cancelled) return;
        setDisplayedMedia({
          blob,
          fileName: requestedFileName,
          filePath: semanticFilePath,
          imageNavigation:
            requestedImageCount !== undefined &&
            requestedImageCurrent !== undefined
              ? {
                  count: requestedImageCount,
                  current: requestedImageCurrent,
                }
              : undefined,
          mediaType,
          path,
          url: pendingObjectUrl,
          vector: isVectorImage(blob.type, path),
        });
        transferredObjectUrl = true;
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load media");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (pendingObjectUrl && !transferredObjectUrl) {
        URL.revokeObjectURL(pendingObjectUrl);
      }
    };
  }, [
    mediaSource,
    mediaType,
    path,
    requestedFileName,
    requestedImageCount,
    requestedImageCurrent,
    semanticFilePath,
    transport,
  ]);

  const displayedUrl = displayedMedia?.url ?? null;
  useEffect(
    () => () => {
      if (displayedUrl) {
        URL.revokeObjectURL(displayedUrl);
      }
    },
    [displayedUrl],
  );

  useEffect(() => {
    if (mediaType !== "image" || !hasImageNavigation) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.altKey || event.ctrlKey || event.metaKey) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        event.stopPropagation();
        imageNavigationInputRef.current = "keyboard";
        setKeyboardNavigationSequence((value) => value + 1);
        imageNavigationRef.current?.onPrevious();
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        event.stopPropagation();
        imageNavigationInputRef.current = "keyboard";
        setKeyboardNavigationSequence((value) => value + 1);
        imageNavigationRef.current?.onNext();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [hasImageNavigation, mediaType]);

  const displayedImage =
    displayedMedia?.mediaType === "image" ? displayedMedia : null;
  const displayedNavigation =
    displayedImage?.imageNavigation && hasImageNavigation
      ? {
          ...displayedImage.imageNavigation,
          onNext: () => imageNavigationRef.current?.onNext(),
          onPrevious: () => imageNavigationRef.current?.onPrevious(),
        }
      : undefined;
  const imageModalActive =
    mediaType === "image" || displayedMedia?.mediaType === "image";
  const openDisplayedImage = useCallback(() => {
    if (displayedMediaRef.current?.mediaType === "image") {
      window.open(displayedMediaRef.current.url, "_blank", "noopener");
    }
  }, []);
  const displayedImageBlob = displayedImage?.blob;
  const imageActions = useImageResourceActions({
    fileName: displayedImage?.fileName ?? requestedFileName,
    filePath: displayedImage?.filePath ?? semanticFilePath,
    loadBlob: displayedImageBlob
      ? () => Promise.resolve(displayedImageBlob)
      : undefined,
    onOpen: openDisplayedImage,
  });

  return (
    <>
      <Modal
        title={
          displayedImage ? (
            <a
              className={styles.titleLink}
              href={displayedImage.url}
              target="_blank"
              rel="noopener noreferrer"
              title={openImageInNewTabLabel}
              onContextMenu={imageActions.handleContextMenu}
            >
              {displayedImage.fileName}
            </a>
          ) : (
            (displayedMedia?.fileName ?? requestedFileName)
          )
        }
        onClose={onClose}
        variant={imageModalActive ? "image-viewer" : undefined}
      >
        {displayedImage ? (
          <div className={styles.imageFrame} aria-busy={loading}>
            <ImageViewer
              key={`${displayedImage.path}\0${displayedImage.url}`}
              fileName={displayedImage.fileName}
              initialNavigationChrome={
                imageNavigationInputRef.current === "keyboard"
                  ? "position"
                  : "all"
              }
              keyboardNavigationSequence={keyboardNavigationSequence}
              navigation={displayedNavigation}
              onContextMenu={imageActions.handleContextMenu}
              onNavigationInput={(input) => {
                imageNavigationInputRef.current = input;
              }}
              onClose={onClose}
              url={displayedImage.url}
              vector={displayedImage.vector}
            />
            {error ? (
              <div className={styles.imageLoadError} role="alert">
                {error}
              </div>
            ) : null}
          </div>
        ) : (
          <div
            className={`${styles.modalContent}${
              imageModalActive ? ` ${styles.imagePlaceholder}` : ""
            }`}
          >
            {loading && <div className={styles.loading}>Loading...</div>}
            {error && <div className={styles.error}>{error}</div>}
            {displayedMedia?.mediaType === "video" ? (
              // biome-ignore lint/a11y/useMediaCaption: user-generated local files, no captions available
              <video
                controls
                autoPlay
                className={styles.player}
                src={displayedMedia.url}
              />
            ) : null}
          </div>
        )}
      </Modal>
      {displayedImage ? imageActions.contextMenuElement : null}
    </>
  );
}

export function LocalFileModal({
  resource,
  initialPresentation,
  onClose,
}: LocalFileModalProps) {
  const sessionMetadata = useOptionalSessionMetadata();
  const transport = useCurrentSourceRuntime().transport;
  const presentation =
    initialPresentation ?? (resource.renderMarkdown ? "preview" : "source");
  const apiPath = localResourceApiPath(resource, presentation === "preview");
  const fileName = getFileName(resource.path);
  const locationSuffix = `${resource.lineNumber !== undefined ? `:${resource.lineNumber}` : ""}${
    resource.columnNumber !== undefined ? `:${resource.columnNumber}` : ""
  }`;
  const displayPath = makeDisplayPath(
    resource.path,
    sessionMetadata?.projectPath,
  );
  const [state, setState] = useState<LocalFileViewState>({
    status: "loading",
  });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setState({ status: "loading" });

    fetchLocalResourceBlob(apiPath, transport)
      .then(async (blob) => {
        if (cancelled) return;
        const contentType = blob.type || "application/octet-stream";

        if (isHtmlContentType(contentType)) {
          const html = await readBlobText(blob);
          if (!cancelled) {
            setState(
              presentation === "preview"
                ? { status: "html", html }
                : { status: "text", contentType, text: html },
            );
          }
          return;
        }

        if (isTextContentType(contentType)) {
          const text = await readBlobText(blob);
          if (!cancelled) {
            setState({ status: "text", contentType, text });
          }
          return;
        }

        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) {
          setState({ status: "blob", contentType, objectUrl });
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setState({
          status: "error",
          error: err instanceof Error ? err.message : "Failed to load file",
        });
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [apiPath, presentation, transport]);

  return (
    <Modal title={fileName} onClose={onClose}>
      <div className={styles.fileModalContent}>
        <div
          className={styles.fileModalMeta}
          title={`${resource.path}${locationSuffix}`}
        >
          {displayPath}
          {locationSuffix}
        </div>
        {state.status === "loading" && (
          <div className={styles.fileLoading}>Loading...</div>
        )}
        {state.status === "error" && (
          <div className={styles.fileError}>{state.error}</div>
        )}
        {state.status === "text" && (
          <div className={styles.fileTextFrame}>
            {/* The global class is the shared fixed-font hook in renderers.css. */}
            <pre className={`${styles.fileText} local-file-text`}>
              <code>{state.text}</code>
            </pre>
          </div>
        )}
        {state.status === "html" && (
          <iframe
            aria-label={fileName}
            className={styles.fileHtmlFrame}
            data-tooltip=""
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={createScriptlessHtmlPreviewDocument(state.html)}
            title={fileName}
          />
        )}
        {state.status === "blob" && isPdfContentType(state.contentType) && (
          <iframe
            className={styles.fileBlobFrame}
            src={state.objectUrl}
            title={fileName}
          />
        )}
        {state.status === "blob" && !isPdfContentType(state.contentType) && (
          <div className={styles.fileError}>
            Preview is not available for {state.contentType || "this file"}.
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * Extract YA-owned semantic resource attributes from a rendered link.
 *
 * These attributes are routing hints. Authorization remains with the route
 * that ultimately serves the resource.
 */
function getLocalResourceAttributes(
  target: HTMLAnchorElement,
): LocalResourceAttributes {
  return {
    "data-ya-resource": target.getAttribute("data-ya-resource"),
    "data-ya-path": target.getAttribute("data-ya-path"),
    "data-ya-project-id": target.getAttribute("data-ya-project-id"),
    "data-ya-line": target.getAttribute("data-ya-line"),
    "data-ya-line-end": target.getAttribute("data-ya-line-end"),
    "data-ya-column": target.getAttribute("data-ya-column"),
    "data-ya-render-markdown": target.getAttribute("data-ya-render-markdown"),
    "data-ya-download": target.getAttribute("data-ya-download"),
    "data-ya-media-type": target.getAttribute("data-ya-media-type"),
  };
}

function getClickedAnchor(
  target: EventTarget | null,
): HTMLAnchorElement | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const directAnchor = target.closest<HTMLAnchorElement>("a[href]");
  if (directAnchor) {
    return directAnchor;
  }

  const preview = target.closest(".local-media-inline-preview");
  const group = preview?.previousElementSibling;
  return group?.querySelector<HTMLAnchorElement>("a[href]") ?? null;
}

function getCurrentHref(): string | undefined {
  return typeof window === "undefined" ? undefined : window.location.href;
}

function isLocalFileResource(resource: LocalResourceRef): boolean {
  return resource.kind === "local-file" || resource.kind === "project-raw-file";
}

function shouldPreserveDirectBrowserGesture(
  e: MouseEvent,
  sameOriginUrls: boolean,
): boolean {
  return (
    sameOriginUrls &&
    (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
  );
}

function getLocalMediaType(
  resource: LocalResourceRef,
  target: HTMLAnchorElement,
): LocalResourceMediaType {
  const mediaTypeAttribute = target.getAttribute("data-media-type");
  if (resource.mediaType) {
    return resource.mediaType;
  }
  if (isLocalMediaType(mediaTypeAttribute)) {
    return mediaTypeAttribute;
  }
  return "image";
}

function LocalResourceContextMenu({
  contextMenu,
  projectContext,
  transport,
  onClose,
  onOpenResource,
}: {
  contextMenu: {
    x: number;
    y: number;
    resource: LocalResourceRef;
    projectFileTarget: ProjectFileModalTarget | null;
    url: string | null;
  };
  projectContext: ProjectContext | null | undefined;
  transport: SourceTransport;
  onClose: () => void;
  onOpenResource: (
    resource: LocalResourceRef,
    target: HTMLAnchorElement,
    presentation?: FileViewPresentation,
  ) => void;
}) {
  const { t } = useI18n();
  const publicShare = usePublicShareContext();
  const basePath = useRemoteBasePath();
  const startNewSessionFromFile = useStartNewSessionFromFileAction();
  const isMedia = contextMenu.resource.kind === "local-media";
  const mediaCoordinates = isMedia
    ? getImagePathCoordinates({
        exposeAbsolutePath: publicShare === null,
        filePath: contextMenu.resource.path,
        projectPath: projectContext?.projectPath,
      })
    : null;
  const projectRelativePath =
    contextMenu.projectFileTarget?.filePath ??
    mediaCoordinates?.projectRelativePath ??
    null;
  const absolutePath = isMedia
    ? (mediaCoordinates?.absolutePath ?? null)
    : publicShare === null
      ? isAbsoluteLikePath(contextMenu.resource.path)
        ? contextMenu.resource.path
        : projectRelativePath && projectContext?.projectPath
          ? getAbsoluteFilePath(projectRelativePath, projectContext.projectPath)
          : null
      : null;
  const viewerLink =
    contextMenu.resource.kind === "project-file"
      ? contextMenu.url
      : publicShare === null
        ? getProjectImageViewerLink({
            basePath,
            projectId: projectContext?.projectId,
            projectRelativePath: mediaCoordinates?.projectRelativePath,
          })
        : null;
  const hasPresentationChoice = supportsSourceAndPreview(
    contextMenu.resource.path,
    Boolean(contextMenu.resource.renderMarkdown),
  );
  const openResource = (presentation?: FileViewPresentation) => {
    const anchor = document.createElement("a");
    anchor.href = "#";
    onOpenResource(contextMenu.resource, anchor, presentation);
  };

  return (
    <FilePathContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      canStartNewSession={
        publicShare === null && !isMedia && Boolean(projectContext?.projectId)
      }
      dismissLabel={
        isMedia ? t("imageResourceDismissMenu" as never) : undefined
      }
      onClose={onClose}
      onOpen={() => openResource()}
      onDownload={
        isMedia
          ? () => {
              void fetchLocalMediaBlob(
                contextMenu.resource.path,
                undefined,
                "modal",
                transport,
              )
                .then((blob) =>
                  downloadBlob(blob, getFileName(contextMenu.resource.path)),
                )
                .catch(() => {});
            }
          : undefined
      }
      onCopyImage={
        isMedia
          ? () => {
              void writeClipboardImageLater(
                fetchLocalMediaBlob(
                  contextMenu.resource.path,
                  undefined,
                  "modal",
                  transport,
                ),
              );
            }
          : undefined
      }
      onOpenSource={
        hasPresentationChoice ? () => openResource("source") : undefined
      }
      onOpenPreview={
        hasPresentationChoice ? () => openResource("preview") : undefined
      }
      onStartNewSession={
        publicShare === null && !isMedia && projectContext?.projectId
          ? () =>
              startNewSessionFromFile(
                projectContext.projectId,
                contextMenu.projectFileTarget?.filePath ??
                  contextMenu.resource.path,
              )
          : undefined
      }
      onCopyProjectRelativePath={
        projectRelativePath
          ? () => void writeClipboardText(projectRelativePath)
          : undefined
      }
      onCopyAbsolutePath={
        absolutePath ? () => void writeClipboardText(absolutePath) : undefined
      }
      onCopyFilePath={
        isMedia
          ? mediaCoordinates?.filePath
            ? () => void writeClipboardText(mediaCoordinates.filePath ?? "")
            : undefined
          : !projectRelativePath &&
              !absolutePath &&
              (publicShare === null ||
                !isAbsoluteLikePath(contextMenu.resource.path))
            ? () => void writeClipboardText(contextMenu.resource.path)
            : undefined
      }
      onCopyViewerLink={
        viewerLink ? () => void writeClipboardText(viewerLink) : undefined
      }
      onCopyContents={
        isMedia
          ? undefined
          : () => {
              const { projectFileTarget, resource } = contextMenu;
              if (projectFileTarget) {
                void writeClipboardTextLater(
                  api
                    .getFile(
                      projectFileTarget.projectId,
                      projectFileTarget.filePath,
                    )
                    .then((file) => file.content ?? ""),
                );
                return;
              }
              void writeClipboardTextLater(
                fetchLocalResourceBlob(
                  localResourceApiPath(resource, false),
                  transport,
                ).then(readBlobText),
              );
            }
      }
    />
  );
}

/**
 * Hook that provides a delegated click handler for rendered HTML containing
 * local-resource links. Local media opens the existing modal. Local file paths
 * under the active project root become project file viewer targets.
 */
export function useLocalResourceClick(
  options: UseLocalResourceClickOptions = {},
): UseLocalResourceClickResult {
  const sessionMetadata = useOptionalSessionMetadata();
  const transport = useCurrentSourceRuntime().transport;
  const sameOriginUrls = transport.capabilities.sameOriginUrls;
  const projectContext = options.projectContext ?? sessionMetadata;
  const [modal, setModal] = useState<{
    path: string;
    mediaType: LocalResourceMediaType;
  } | null>(null);
  const [localFileModal, setLocalFileModal] =
    useState<LocalFileModalTarget | null>(null);
  const [projectFileModal, setProjectFileModal] =
    useState<ProjectFileModalTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    resource: LocalResourceRef;
    projectFileTarget: ProjectFileModalTarget | null;
    url: string | null;
  } | null>(null);

  const openResource = (
    resource: LocalResourceRef,
    target: HTMLAnchorElement,
    presentation?: FileViewPresentation,
  ) => {
    const projectFileTarget = normalizeResourceForProjectContext(
      resource,
      projectContext,
    );
    if (projectFileTarget) {
      setProjectFileModal({
        ...projectFileTarget,
        ...(presentation ? { initialPresentation: presentation } : {}),
      });
      setLocalFileModal(null);
      setModal(null);
      return true;
    }

    if (resource.kind === "local-media") {
      setModal({
        path: resource.path,
        mediaType: getLocalMediaType(resource, target),
      });
      setLocalFileModal(null);
      setProjectFileModal(null);
      return true;
    }

    if (isLocalFileResource(resource)) {
      setLocalFileModal({
        resource,
        ...(presentation ? { initialPresentation: presentation } : {}),
      });
      setModal(null);
      setProjectFileModal(null);
      return true;
    }

    return false;
  };

  const handleClick = (e: MouseEvent) => {
    if (!(e.target instanceof Element)) {
      return;
    }

    const toggle = e.target.closest(
      "button.local-media-inline-toggle",
    ) as HTMLButtonElement | null;
    if (toggle) {
      e.preventDefault();
      e.stopPropagation();

      const mediaTypeAttribute = toggle.getAttribute("data-media-type");
      const mediaType = isLocalMediaType(mediaTypeAttribute)
        ? mediaTypeAttribute
        : "image";
      const expanded = toggle.getAttribute("data-expanded") !== "false";
      const nextExpanded = !expanded;
      const preview =
        toggle.closest(".local-media-link-group")?.nextElementSibling ?? null;

      toggle.dataset.userToggled = "true";
      toggle.dataset.expanded = String(nextExpanded);
      toggle.setAttribute("aria-expanded", String(nextExpanded));
      toggle.setAttribute(
        "aria-label",
        `${nextExpanded ? "Collapse" : "Expand"} ${mediaType}`,
      );
      toggle.title = nextExpanded
        ? "Collapse inline preview"
        : "Expand inline preview";
      toggle.textContent = nextExpanded ? "-" : "+";
      if (
        preview instanceof HTMLElement &&
        preview.classList.contains("local-media-inline-preview")
      ) {
        preview.dataset.userToggled = "true";
        preview.setAttribute("data-expanded", String(nextExpanded));
      }
      return;
    }

    const target = getClickedAnchor(e.target);
    if (!target) return;

    const href = target.getAttribute("href");
    const resource = parseLocalResourceLink(
      {
        attributes: getLocalResourceAttributes(target),
        href,
      },
      { currentHref: getCurrentHref() },
    );
    if (!resource) return;

    const projectFileTarget = normalizeResourceForProjectContext(
      resource,
      projectContext,
    );
    if (projectFileTarget) {
      if (shouldPreserveDirectBrowserGesture(e, sameOriginUrls)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      openResource(resource, target);
      return;
    }

    if (resource.kind === "local-media") {
      e.preventDefault();
      e.stopPropagation();
      openResource(resource, target);
      return;
    }

    if (isLocalFileResource(resource)) {
      if (shouldPreserveDirectBrowserGesture(e, sameOriginUrls)) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      openResource(resource, target);
    }
  };

  const handleContextMenu = (e: MouseEvent) => {
    const target = getClickedAnchor(e.target);
    if (!target) return;

    const href = target.getAttribute("href");
    const resource = parseLocalResourceLink(
      {
        attributes: getLocalResourceAttributes(target),
        href,
      },
      { currentHref: getCurrentHref() },
    );
    if (!resource) return;

    e.preventDefault();
    e.stopPropagation();
    setContextMenu({
      x: e.clientX,
      y: e.clientY,
      resource,
      projectFileTarget: normalizeResourceForProjectContext(
        resource,
        projectContext,
      ),
      url: resource.kind === "project-file" ? target.href : null,
    });
  };

  const closeModal = () => setModal(null);
  const closeLocalFileModal = () => setLocalFileModal(null);
  const closeProjectFileModal = () => setProjectFileModal(null);
  const closeContextMenu = () => setContextMenu(null);
  const contextMenuElement = contextMenu ? (
    <LocalResourceContextMenu
      contextMenu={contextMenu}
      projectContext={projectContext}
      transport={transport}
      onClose={closeContextMenu}
      onOpenResource={openResource}
    />
  ) : null;

  return {
    modal,
    localFileModal,
    projectFileModal,
    handleClick,
    handleContextMenu,
    closeModal,
    closeLocalFileModal,
    closeProjectFileModal,
    contextMenuElement,
  };
}

/**
 * Compatibility alias for existing callers during the local-resource migration.
 */
export function useLocalMediaClick() {
  return useLocalResourceClick();
}

export function useLocalMediaInlinePreviews(
  rootRef: RefObject<HTMLElement | null>,
  refreshKey?: unknown,
  mediaSource?: LocalMediaSource,
  options: { suppressAutomaticImages?: boolean } = {},
) {
  const { inlineMediaExpandedByDefault } = useInlineMedia();
  const transport = useCurrentSourceRuntime().transport;

  useEffect(() => {
    void refreshKey;
    const root = rootRef.current;
    if (!root) return;
    const objectUrls = new Set<string>();

    const getInlineMediaType = (element: HTMLElement) => {
      const mediaType = element.getAttribute("data-media-type");
      return isLocalMediaType(mediaType) ? mediaType : "image";
    };

    const setToggleExpanded = (
      toggle: HTMLButtonElement,
      expanded: boolean,
      mediaType: LocalResourceMediaType,
    ) => {
      toggle.dataset.expanded = String(expanded);
      toggle.setAttribute("aria-expanded", String(expanded));
      toggle.setAttribute(
        "aria-label",
        `${expanded ? "Collapse" : "Expand"} ${mediaType}`,
      );
      toggle.title = expanded
        ? "Collapse inline preview"
        : "Expand inline preview";
      toggle.textContent = expanded ? "-" : "+";
    };

    const getPreviewForToggle = (
      toggle: HTMLButtonElement,
    ): HTMLElement | null => {
      const preview =
        toggle.closest(".local-media-link-group")?.nextElementSibling ?? null;
      return preview instanceof HTMLElement &&
        preview.classList.contains("local-media-inline-preview")
        ? preview
        : null;
    };

    const syncDefaultExpansion = () => {
      const toggles = root.querySelectorAll<HTMLButtonElement>(
        "button.local-media-inline-toggle",
      );
      for (const toggle of toggles) {
        if (toggle.dataset.userToggled === "true") continue;
        const mediaType = getInlineMediaType(toggle);
        const defaultExpanded =
          options.suppressAutomaticImages && mediaType === "image"
            ? false
            : inlineMediaExpandedByDefault;
        if (toggle.dataset.defaultExpanded === String(defaultExpanded)) {
          continue;
        }

        setToggleExpanded(toggle, defaultExpanded, mediaType);
        toggle.dataset.defaultExpanded = String(defaultExpanded);

        const preview = getPreviewForToggle(toggle);
        if (preview && preview.dataset.userToggled !== "true") {
          preview.setAttribute("data-expanded", String(defaultExpanded));
          preview.dataset.defaultExpanded = String(defaultExpanded);
        }
      }
    };

    const refresh = () => {
      syncDefaultExpansion();
      const elements = Array.from(
        root.querySelectorAll<HTMLElement>(".local-media-inline-preview"),
      );
      for (const element of elements) {
        if (element.getAttribute("data-expanded") === "false") continue;
        if (element.dataset.inlineMounted === "true") continue;
        const path = element.getAttribute("data-media-path");
        if (!path) continue;
        const mediaType = getInlineMediaType(element);
        element.dataset.inlineMounted = "true";
        element.replaceChildren();

        const loading = document.createElement("span");
        loading.className = inlinePreviewClass.loading;
        loading.textContent = "Loading...";
        element.append(loading);

        fetchLocalMediaBlob(path, mediaSource, "inline", transport)
          .then(async (blob) => {
            const objectUrl = URL.createObjectURL(blob);
            objectUrls.add(objectUrl);
            const sizing = await describeImageSizing(blob, path);
            renderInlinePreview(element, path, mediaType, objectUrl, sizing);
          })
          .catch((err) => {
            const error = document.createElement("span");
            error.className = inlinePreviewClass.error;
            error.textContent =
              err instanceof Error ? err.message : "Failed to load media";
            element.replaceChildren(error);
          });
      }
    };

    refresh();
    const observer = new MutationObserver(refresh);
    observer.observe(root, {
      attributeFilter: ["data-expanded"],
      attributes: true,
      childList: true,
      subtree: true,
    });
    return () => {
      observer.disconnect();
      for (const url of objectUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [
    inlineMediaExpandedByDefault,
    rootRef,
    refreshKey,
    mediaSource,
    options.suppressAutomaticImages,
    transport,
  ]);
}
