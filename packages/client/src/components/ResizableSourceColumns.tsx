import {
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  useEffect,
  useState,
} from "react";
import type { TranslationFn } from "../i18n";

type SourceColumnLayout = "history" | "files";
type Boundary = "revisions" | "files";

const REVISION_MIN = 240;
const REVISION_MAX = 420;
const FILES_MIN = 220;
const FILES_MAX = 500;
const KEYBOARD_STEP = 16;

interface Widths {
  revisions: number;
  files: number;
}

interface DragState {
  boundary: Boundary;
  startX: number;
  startWidths: Widths;
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
  const [widths, setWidths] = useState<Widths>(() => ({
    revisions: 300,
    files: initialFilesWidth ?? (layout === "history" ? 340 : 380),
  }));
  const [dragging, setDragging] = useState<DragState | null>(null);

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
                FILES_MAX,
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
  }, [dragging]);

  const setBoundaryWidth = (boundary: Boundary, next: number) => {
    setWidths((current) => ({
      ...current,
      [boundary]: clamp(
        next,
        boundary === "revisions" ? REVISION_MIN : FILES_MIN,
        boundary === "revisions" ? REVISION_MAX : FILES_MAX,
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
    const max = boundary === "revisions" ? REVISION_MAX : FILES_MAX;
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
    <div className={className} style={style}>
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
                  boundary === "revisions" ? REVISION_MAX : FILES_MAX
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
