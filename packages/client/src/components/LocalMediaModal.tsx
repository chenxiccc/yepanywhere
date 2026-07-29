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
  useEffect,
  useState,
} from "react";
import { api } from "../api/client";
import { useOptionalSessionMetadata } from "../contexts/SessionMetadataContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useInlineMedia } from "../hooks/useInlineMedia";
import { useI18n } from "../i18n";
import { writeClipboardText, writeClipboardTextLater } from "../lib/clipboard";
import { getSourceRuntimeRegistry } from "../lib/sourceRuntime";
import { toSourceTransportApiPath } from "../lib/sourceTransportPaths";
import {
  getPathBasename,
  getProjectRelativePath,
  makeDisplayPath,
} from "../lib/text";
import type { SourceTransport } from "../lib/transport";
import {
  FilePathContextMenu,
  useStartNewSessionFromFileAction,
} from "./FileResourceActions";
import { ImageViewer } from "./ImageViewer";
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
  mediaType: LocalResourceMediaType;
  mediaSource?: LocalMediaSource;
  onClose: () => void;
}

interface LocalFileModalProps {
  resource: LocalResourceRef;
  onClose: () => void;
}

export interface ProjectFileModalTarget {
  projectId: string;
  filePath: string;
  lineNumber?: number;
  lineEnd?: number;
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
  localFileModal: LocalResourceRef | null;
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
  sameOriginUrls: boolean,
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
  if (resource.renderMarkdown && sameOriginUrls) {
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

async function copyImageBlobToClipboard(blob: Blob): Promise<void> {
  const ClipboardItemCtor = globalThis.ClipboardItem;
  if (!navigator.clipboard?.write || !ClipboardItemCtor) {
    throw new Error("Image clipboard is not available");
  }
  const clipboardBlob =
    blob.type === "image/png" ? blob : await toPngBlob(blob);
  await navigator.clipboard.write([
    new ClipboardItemCtor({
      [clipboardBlob.type || "image/png"]: clipboardBlob,
    }),
  ]);
}

async function toPngBlob(blob: Blob): Promise<Blob> {
  const sourceUrl = URL.createObjectURL(blob);
  try {
    const image = new Image();
    const loaded = new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error("Failed to decode image"));
    });
    image.src = sourceUrl;
    await loaded;

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Canvas is not available");
    }
    context.drawImage(image, 0, 0);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((pngBlob) => {
        if (pngBlob) {
          resolve(pngBlob);
        } else {
          reject(new Error("Failed to encode PNG"));
        }
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
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

function renderInlinePreview(
  target: HTMLElement,
  path: string,
  mediaType: LocalResourceMediaType,
  blob: Blob,
  objectUrl: string,
) {
  const frame = document.createElement("span");
  frame.className = "local-media-inline-frame";

  if (mediaType === "video") {
    const video = document.createElement("video");
    video.controls = true;
    video.muted = true;
    video.className = "local-media-inline-player";
    video.src = objectUrl;
    frame.append(video);
  } else {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "local-media-inline-image-button";
    button.title = "Copy image";
    button.setAttribute("aria-label", `Copy ${getFileName(path)}`);

    const image = document.createElement("img");
    image.className = "local-media-inline-image";
    image.src = objectUrl;
    image.alt = getFileName(path);
    button.append(image);

    button.addEventListener("click", async () => {
      try {
        await copyImageBlobToClipboard(blob);
        button.classList.add("copied");
        button.title = "Copied";
        button.setAttribute("aria-label", "Copied image");

        const copied = document.createElement("span");
        copied.className = "local-media-inline-copied";
        copied.textContent = "Copied";
        frame.append(copied);
        setTimeout(() => {
          button.classList.remove("copied");
          button.title = "Copy image";
          button.setAttribute("aria-label", `Copy ${getFileName(path)}`);
          copied.remove();
        }, 1500);
      } catch (err) {
        console.error("[LocalMediaInlinePreview] Failed to copy image:", err);
      }
    });

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
  mediaType,
  mediaSource,
  onClose,
}: LocalMediaModalProps) {
  const { t } = useI18n();
  const transport = useCurrentSourceRuntime().transport;
  const [url, setUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const fileName = getFileName(path);
  const openImageInNewTabLabel = t("fileViewerOpenImageNewTab" as never);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setLoading(true);
    setError(null);
    setUrl(null);

    void fetchLocalMediaBlob(path, mediaSource, "modal", transport)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load media");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [mediaSource, path, transport]);

  return (
    <Modal
      title={
        url && mediaType === "image" ? (
          <a
            className="local-media-title-link"
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            title={openImageInNewTabLabel}
          >
            {fileName}
          </a>
        ) : (
          fileName
        )
      }
      onClose={onClose}
    >
      {url && mediaType === "image" ? (
        <ImageViewer fileName={fileName} onClose={onClose} url={url} />
      ) : (
        <div className="local-media-modal-content">
          {loading && <div className="local-media-loading">Loading...</div>}
          {error && <div className="local-media-error">{error}</div>}
          {url && mediaType === "video" ? (
            // biome-ignore lint/a11y/useMediaCaption: user-generated local files, no captions available
            <video controls autoPlay className="local-media-player" src={url} />
          ) : null}
        </div>
      )}
    </Modal>
  );
}

export function LocalFileModal({ resource, onClose }: LocalFileModalProps) {
  const sessionMetadata = useOptionalSessionMetadata();
  const transport = useCurrentSourceRuntime().transport;
  const sameOriginUrls = transport.capabilities.sameOriginUrls;
  const apiPath = localResourceApiPath(resource, sameOriginUrls);
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
              sameOriginUrls
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
  }, [apiPath, sameOriginUrls, transport]);

  return (
    <Modal title={fileName} onClose={onClose}>
      <div className="local-file-modal-content">
        <div
          className="local-file-modal-meta"
          title={`${resource.path}${locationSuffix}`}
        >
          {displayPath}
          {locationSuffix}
        </div>
        {state.status === "loading" && (
          <div className="local-file-loading">Loading...</div>
        )}
        {state.status === "error" && (
          <div className="local-file-error">{state.error}</div>
        )}
        {state.status === "text" && (
          <div className="local-file-text-frame">
            <pre className="local-file-text">
              <code>{state.text}</code>
            </pre>
          </div>
        )}
        {state.status === "html" && (
          <iframe
            className="local-file-html-frame"
            sandbox=""
            srcDoc={state.html}
            title={fileName}
          />
        )}
        {state.status === "blob" && isPdfContentType(state.contentType) && (
          <iframe
            className="local-file-blob-frame"
            src={state.objectUrl}
            title={fileName}
          />
        )}
        {state.status === "blob" && !isPdfContentType(state.contentType) && (
          <div className="local-file-error">
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
  return target.closest("a[href]");
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
  sameOriginUrls,
  transport,
  onClose,
  onOpenResource,
}: {
  contextMenu: {
    x: number;
    y: number;
    resource: LocalResourceRef;
    projectFileTarget: ProjectFileModalTarget | null;
  };
  projectContext: ProjectContext | null | undefined;
  sameOriginUrls: boolean;
  transport: SourceTransport;
  onClose: () => void;
  onOpenResource: (
    resource: LocalResourceRef,
    target: HTMLAnchorElement,
  ) => void;
}) {
  const startNewSessionFromFile = useStartNewSessionFromFileAction();

  return (
    <FilePathContextMenu
      x={contextMenu.x}
      y={contextMenu.y}
      canStartNewSession={Boolean(projectContext?.projectId)}
      onClose={onClose}
      onView={() => {
        const anchor = document.createElement("a");
        anchor.href = "#";
        onOpenResource(contextMenu.resource, anchor);
      }}
      onStartNewSession={
        projectContext?.projectId
          ? () =>
              startNewSessionFromFile(
                projectContext.projectId,
                contextMenu.projectFileTarget?.filePath ??
                  contextMenu.resource.path,
              )
          : undefined
      }
      onCopyPath={() =>
        void writeClipboardText(
          contextMenu.projectFileTarget?.filePath ?? contextMenu.resource.path,
        )
      }
      onCopyContents={() => {
        const { projectFileTarget, resource } = contextMenu;
        if (projectFileTarget) {
          void writeClipboardTextLater(
            api
              .getFile(projectFileTarget.projectId, projectFileTarget.filePath)
              .then((file) => file.content ?? ""),
          );
          return;
        }
        void writeClipboardTextLater(
          fetchLocalResourceBlob(
            localResourceApiPath(resource, sameOriginUrls),
            transport,
          ).then(readBlobText),
        );
      }}
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
  const [localFileModal, setLocalFileModal] = useState<LocalResourceRef | null>(
    null,
  );
  const [projectFileModal, setProjectFileModal] =
    useState<ProjectFileModalTarget | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    resource: LocalResourceRef;
    projectFileTarget: ProjectFileModalTarget | null;
  } | null>(null);

  const openResource = (
    resource: LocalResourceRef,
    target: HTMLAnchorElement,
  ) => {
    const projectFileTarget = normalizeResourceForProjectContext(
      resource,
      projectContext,
    );
    if (projectFileTarget) {
      setProjectFileModal(projectFileTarget);
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
      setLocalFileModal(resource);
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
    if (!resource || resource.kind === "local-media") return;

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
      sameOriginUrls={sameOriginUrls}
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
        loading.className = "local-media-inline-loading";
        loading.textContent = "Loading...";
        element.append(loading);

        fetchLocalMediaBlob(path, mediaSource, "inline", transport)
          .then((blob) => {
            const objectUrl = URL.createObjectURL(blob);
            objectUrls.add(objectUrl);
            renderInlinePreview(element, path, mediaType, blob, objectUrl);
          })
          .catch((err) => {
            const error = document.createElement("span");
            error.className = "local-media-inline-error";
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
