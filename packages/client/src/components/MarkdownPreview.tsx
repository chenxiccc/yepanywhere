import {
  type CSSProperties,
  forwardRef,
  type KeyboardEventHandler,
  type MouseEventHandler,
  useCallback,
  useMemo,
  useState,
} from "react";
import { useGlossaryArtifact } from "../contexts/GlossaryContext";
import { annotateGlossaryHtml } from "../lib/glossary/annotateGlossaryHtml";

const FILE_VIEWER_DENSITY_STORAGE_KEY = "yep-anywhere-file-viewer-density-zoom";
const FILE_VIEWER_DENSITY_MIN = -4;
const FILE_VIEWER_DENSITY_MAX = 6;
const FILE_VIEWER_FONT_STEP_PX = 0.5;
const FILE_VIEWER_VSPACE_STEP_PX = 1;
export interface MarkdownPreviewDensityOffsets {
  fontSizeOffsetPx?: number;
  verticalSpacingOffsetPx?: number;
}

type MarkdownPreviewStyle = CSSProperties & {
  "--markdown-preview-font-size-offset"?: string;
  "--markdown-preview-vspace-offset"?: string;
  "--source-font-size-offset"?: string;
  "--source-vspace-offset"?: string;
};

export const FILE_MARKDOWN_PREVIEW_BASE_DENSITY: MarkdownPreviewDensityOffsets =
  {
    fontSizeOffsetPx: -1,
    verticalSpacingOffsetPx: -2,
  };

export const FILE_SOURCE_BASE_DENSITY: MarkdownPreviewDensityOffsets = {
  fontSizeOffsetPx: 0,
  verticalSpacingOffsetPx: 0,
};

function clampDensityZoom(value: number): number {
  return Math.min(
    FILE_VIEWER_DENSITY_MAX,
    Math.max(FILE_VIEWER_DENSITY_MIN, value),
  );
}

function readStoredDensityZoom(): number {
  if (typeof sessionStorage === "undefined") {
    return 0;
  }
  try {
    const stored = Number(
      sessionStorage.getItem(FILE_VIEWER_DENSITY_STORAGE_KEY),
    );
    return Number.isFinite(stored) ? clampDensityZoom(stored) : 0;
  } catch {
    return 0;
  }
}

function writeStoredDensityZoom(value: number) {
  if (typeof sessionStorage === "undefined") {
    return;
  }
  try {
    if (value === 0) {
      sessionStorage.removeItem(FILE_VIEWER_DENSITY_STORAGE_KEY);
    } else {
      sessionStorage.setItem(FILE_VIEWER_DENSITY_STORAGE_KEY, String(value));
    }
  } catch {
    // The in-memory density still applies when storage is unavailable.
  }
}

export function combineDensityOffsets(
  base: MarkdownPreviewDensityOffsets,
  adjustment: MarkdownPreviewDensityOffsets,
): MarkdownPreviewDensityOffsets {
  return {
    fontSizeOffsetPx:
      (base.fontSizeOffsetPx ?? 0) + (adjustment.fontSizeOffsetPx ?? 0),
    verticalSpacingOffsetPx:
      (base.verticalSpacingOffsetPx ?? 0) +
      (adjustment.verticalSpacingOffsetPx ?? 0),
  };
}

export function getMarkdownPreviewStyle({
  fontSizeOffsetPx = 0,
  verticalSpacingOffsetPx = 0,
}: MarkdownPreviewDensityOffsets = {}): MarkdownPreviewStyle {
  return {
    "--markdown-preview-font-size-offset": `${fontSizeOffsetPx}px`,
    "--markdown-preview-vspace-offset": `${verticalSpacingOffsetPx}px`,
  };
}

export function getSourceViewStyle({
  fontSizeOffsetPx = 0,
  verticalSpacingOffsetPx = 0,
}: MarkdownPreviewDensityOffsets = {}): MarkdownPreviewStyle {
  return {
    "--source-font-size-offset": `${fontSizeOffsetPx}px`,
    "--source-vspace-offset": `${verticalSpacingOffsetPx}px`,
  };
}

export function useFileViewerDensity() {
  const [zoom, setZoom] = useState(readStoredDensityZoom);
  const density = useMemo<MarkdownPreviewDensityOffsets>(
    () => ({
      fontSizeOffsetPx: zoom * FILE_VIEWER_FONT_STEP_PX,
      verticalSpacingOffsetPx: zoom * FILE_VIEWER_VSPACE_STEP_PX,
    }),
    [zoom],
  );
  const setBoundedZoom = useCallback((nextZoom: number) => {
    const bounded = clampDensityZoom(nextZoom);
    setZoom(bounded);
    writeStoredDensityZoom(bounded);
  }, []);
  return {
    canZoomIn: zoom < FILE_VIEWER_DENSITY_MAX,
    canZoomOut: zoom > FILE_VIEWER_DENSITY_MIN,
    density,
    zoom,
    zoomIn: () => setBoundedZoom(zoom + 1),
    zoomOut: () => setBoundedZoom(zoom - 1),
  };
}

interface MarkdownPreviewProps {
  ariaLabel?: string;
  className?: string;
  density?: MarkdownPreviewDensityOffsets;
  html: string;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onContextMenu?: MouseEventHandler<HTMLDivElement>;
  onKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  sourcePath?: string;
}

export const MarkdownPreview = forwardRef<HTMLDivElement, MarkdownPreviewProps>(
  function MarkdownPreview(
    {
      ariaLabel,
      className,
      density,
      html,
      onClick,
      onContextMenu,
      onKeyDown,
      sourcePath,
    },
    ref,
  ) {
    const classes = ["markdown-preview", className].filter(Boolean).join(" ");
    const glossary = useGlossaryArtifact(sourcePath);
    const renderedHtml = useMemo(() => {
      if (glossary.state !== "ready" || glossary.result?.status !== "ready") {
        return html;
      }
      return annotateGlossaryHtml(html, glossary.result.artifact).html;
    }, [glossary, html]);
    return (
      <div
        className={classes}
        role="region"
        aria-label={ariaLabel ?? "Markdown preview"}
        onClick={onClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        ref={ref}
        style={getMarkdownPreviewStyle(density)}
      >
        <div
          className="markdown-rendered"
          // biome-ignore lint/security/noDangerouslySetInnerHtml: server-rendered markdown is sanitized
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      </div>
    );
  },
);

interface MarkdownViewToggleProps {
  onShowPreview: () => void;
  onShowSource: () => void;
  previewLabel: string;
  showPreview: boolean;
  sourceLabel: string;
}

export function MarkdownViewToggle({
  onShowPreview,
  onShowSource,
  previewLabel,
  showPreview,
  sourceLabel,
}: MarkdownViewToggleProps) {
  return (
    <div className="markdown-view-toggle">
      <button
        type="button"
        className={`toggle-btn ${!showPreview ? "active" : ""}`}
        onClick={onShowSource}
      >
        {sourceLabel}
      </button>
      <button
        type="button"
        className={`toggle-btn ${showPreview ? "active" : ""}`}
        onClick={onShowPreview}
      >
        {previewLabel}
      </button>
    </div>
  );
}

interface FileViewerDensityControlsProps {
  canZoomIn: boolean;
  canZoomOut: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  zoom: number;
}

export function FileViewerDensityControls({
  canZoomIn,
  canZoomOut,
  onZoomIn,
  onZoomOut,
  zoom,
}: FileViewerDensityControlsProps) {
  return (
    <div
      className="file-viewer-density-controls"
      role="group"
      aria-label="Source zoom"
    >
      <button
        type="button"
        className="file-viewer-action"
        onClick={onZoomOut}
        disabled={!canZoomOut}
        title="Zoom source and preview out"
        aria-label="Zoom source and preview out"
      >
        <MinusIcon />
      </button>
      <span className="file-viewer-density-value" aria-hidden="true">
        {zoom > 0 ? `+${zoom}` : zoom}
      </span>
      <button
        type="button"
        className="file-viewer-action"
        onClick={onZoomIn}
        disabled={!canZoomIn}
        title="Zoom source and preview in"
        aria-label="Zoom source and preview in"
      >
        <PlusIcon />
      </button>
    </div>
  );
}

function MinusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
      <path
        d="M8 3v10M3 8h10"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
