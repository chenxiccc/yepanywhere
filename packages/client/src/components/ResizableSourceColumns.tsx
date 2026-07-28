import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { TranslationFn } from "../i18n";

export type SourceColumnLayout = "history" | "files";
type Boundary = "revisions" | "files";

const REVISION_MIN = 240;
const REVISION_MAX = 420;
const FILES_MIN = 220;
const KEYBOARD_STEP = 16;
const FALLBACK_COLUMN_GAP = 12;
const FALLBACK_HANDLE_WIDTH = 26;

interface Widths {
  revisions: number;
  files: number;
}

interface DragState {
  boundary: Boundary;
  startX: number;
  startWidths: Widths;
}

interface LayoutMetrics {
  containerWidth: number;
  gapWidth: number;
  handleWidth: number;
}

/**
 * Let the file pane consume all requested width while keeping the right edge
 * of its splitter handle inside the grid.
 */
export function calculateSourceFilesMaxWidth({
  layout,
  containerWidth,
  revisionWidth,
  gapWidth,
  handleWidth,
}: {
  layout: SourceColumnLayout;
  containerWidth: number;
  revisionWidth: number;
  gapWidth: number;
  handleWidth: number;
}): number {
  const precedingWidth =
    layout === "history" ? revisionWidth + gapWidth : 0;
  return Math.max(
    FILES_MIN,
    Math.floor(
      containerWidth -
        precedingWidth -
        gapWidth / 2 -
        handleWidth / 2,
    ),
  );
}

/**
 * Desktop Source Control grids with edge-only resize handles. The tiny top and
 * bottom handles keep the pane interiors clean; interaction reveals one full
 * height guide while the grid reflows live.
 */
export function ResizableSourceColumns({
  layout,
  enabled = true,
  initialFilesWidth,
  className,
  children,
  t,
}: {
  layout: SourceColumnLayout;
  enabled?: boolean;
  initialFilesWidth?: number;
  className: string;
  children: ReactNode;
  t: TranslationFn;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [widths, setWidths] = useState<Widths>(() => ({
    revisions: 300,
    files: initialFilesWidth ?? (layout === "history" ? 340 : 380),
  }));
  const [dragging, setDragging] = useState<DragState | null>(null);
  const [layoutMetrics, setLayoutMetrics] = useState<LayoutMetrics | null>(
    null,
  );
  const filesMax = layoutMetrics
    ? calculateSourceFilesMaxWidth({
        layout,
        containerWidth: layoutMetrics.containerWidth,
        revisionWidth: widths.revisions,
        gapWidth: layoutMetrics.gapWidth,
        handleWidth: layoutMetrics.handleWidth,
      })
    : undefined;

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const styles = getComputedStyle(root);
      const parsedGap = Number.parseFloat(styles.columnGap);
      const handle = root.querySelector<HTMLElement>(
        ".source-pane-splitter-handle",
      );
      const next = {
        containerWidth: root.clientWidth,
        gapWidth: Number.isFinite(parsedGap)
          ? parsedGap
          : FALLBACK_COLUMN_GAP,
        handleWidth: handle?.offsetWidth || FALLBACK_HANDLE_WIDTH,
      };
      if (next.containerWidth <= 0) return;
      setLayoutMetrics((current) =>
        current &&
        current.containerWidth === next.containerWidth &&
        current.gapWidth === next.gapWidth &&
        current.handleWidth === next.handleWidth
          ? current
          : next,
      );
    };

    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (filesMax === undefined) return;
    setWidths((current) =>
      current.files <= filesMax ? current : { ...current, files: filesMax },
    );
  }, [filesMax]);

  useEffect(() => {
    if (!dragging) return;
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const delta = event.clientX - dragging.startX;
      setWidths(
        dragging.boundary === "revisions"
          ? {
              ...dragging.startWidths,
              revisions: clamp(
                dragging.startWidths.revisions + delta,
                REVISION_MIN,
                REVISION_MAX,
              ),
            }
          : {
              ...dragging.startWidths,
              files: clamp(
                dragging.startWidths.files + delta,
                FILES_MIN,
                filesMax ?? dragging.startWidths.files,
              ),
            },
      );
    };
    const handlePointerUp = () => setDragging(null);
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp, { once: true });
    window.addEventListener("pointercancel", handlePointerUp, { once: true });
    document.body.classList.add("source-pane-resizing");
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerUp);
      document.body.classList.remove("source-pane-resizing");
    };
  }, [dragging, filesMax]);

  const setBoundaryWidth = (boundary: Boundary, next: number) => {
    setWidths((current) => ({
      ...current,
      [boundary]: clamp(
        next,
        boundary === "revisions" ? REVISION_MIN : FILES_MIN,
        boundary === "revisions"
          ? REVISION_MAX
          : (filesMax ?? current.files),
      ),
    }));
  };

  const startDrag = (event: PointerEvent<HTMLElement>, boundary: Boundary) => {
    if (event.button !== 0) return;
    event.preventDefault();
    setDragging({
      boundary,
      startX: event.clientX,
      startWidths: widths,
    });
  };

  const handleKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    boundary: Boundary,
  ) => {
    const current = widths[boundary];
    const min = boundary === "revisions" ? REVISION_MIN : FILES_MIN;
    const max =
      boundary === "revisions" ? REVISION_MAX : (filesMax ?? current);
    const next =
      event.key === "ArrowLeft"
        ? current - KEYBOARD_STEP
        : event.key === "ArrowRight"
          ? current + KEYBOARD_STEP
          : event.key === "Home"
            ? min
            : event.key === "End"
              ? max
              : null;
    if (next === null) return;
    event.preventDefault();
    setBoundaryWidth(boundary, next);
  };

  const style = {
    "--source-revision-column-width": `${widths.revisions}px`,
    "--source-files-column-width": `${widths.files}px`,
  } as CSSProperties;
  const boundaries: Boundary[] =
    layout === "history" ? ["revisions", "files"] : ["files"];

  return (
    <div ref={rootRef} className={className} style={style}>
      {children}
      {enabled &&
        boundaries.map((boundary) => (
          <div
            key={boundary}
            className={`source-pane-splitter source-pane-splitter-${boundary} ${
              dragging?.boundary === boundary ? "dragging" : ""
            }`}
          >
            <span className="source-pane-splitter-guide" aria-hidden="true" />
            {(["top", "bottom"] as const).map((edge) => (
              <span
                key={edge}
                className={`source-pane-splitter-handle ${edge}`}
                role="separator"
                aria-label={t(
                  boundary === "revisions"
                    ? "sourceResizeRevisionPane"
                    : "sourceResizeFilePane",
                )}
                aria-orientation="vertical"
                aria-valuemin={
                  boundary === "revisions" ? REVISION_MIN : FILES_MIN
                }
                aria-valuemax={
                  boundary === "revisions" ? REVISION_MAX : filesMax
                }
                aria-valuenow={widths[boundary]}
                tabIndex={0}
                onPointerDown={(event) => startDrag(event, boundary)}
                onKeyDown={(event) => handleKeyDown(event, boundary)}
              >
                <span aria-hidden="true">‹›</span>
              </span>
            ))}
          </div>
        ))}
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
