import {
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useI18n } from "../i18n";

interface ImageDimensions {
  height: number;
  width: number;
}

export interface ImageViewerNavigation {
  count: number;
  current: number;
  onNext: () => void;
  onPrevious: () => void;
}

export type ImageViewerNavigationInput = "controls" | "keyboard";

const IMAGE_VIEWER_PADDING_PX = 32;
const IMAGE_VIEWER_NAVIGATION_IDLE_MS = 1_800;
const IMAGE_VIEWER_NAVIGATION_TOUCH_IDLE_MS = 2_600;
const IMAGE_ZOOM_MIN = 0.1;
const IMAGE_ZOOM_MAX = 8;
const IMAGE_ZOOM_STEP = 1.25;

function ImageViewerChevron({
  direction,
}: {
  direction: "next" | "previous";
}) {
  return (
    <svg
      className="local-media-image-navigation-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        d={direction === "previous" ? "m15 18-6-6 6-6" : "m9 6 6 6-6 6"}
      />
    </svg>
  );
}

function clampImageScale(scale: number): number {
  return Math.min(IMAGE_ZOOM_MAX, Math.max(IMAGE_ZOOM_MIN, scale));
}

function pointerDistance(
  first: { x: number; y: number },
  second: { x: number; y: number },
): number {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

export function ImageViewer({
  fileName,
  initialNavigationChrome = "all",
  keyboardNavigationSequence = 0,
  navigation,
  onNavigationInput,
  onClose,
  url,
}: {
  fileName: string;
  initialNavigationChrome?: "all" | "position";
  keyboardNavigationSequence?: number;
  navigation?: ImageViewerNavigation;
  onNavigationInput?: (input: ImageViewerNavigationInput) => void;
  onClose: () => void;
  url: string;
}) {
  const { t } = useI18n();
  const stageRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const gestureRef = useRef<
    | {
        kind: "pan";
        scrollLeft: number;
        scrollTop: number;
        x: number;
        y: number;
      }
    | {
        distance: number;
        kind: "pinch";
        scale: number;
      }
    | null
  >(null);
  const suppressClickRef = useRef(false);
  const navigationFocusWithinRef = useRef(false);
  const navigationHideTimerRef = useRef<number | null>(null);
  const keyboardNavigationSequenceRef = useRef(keyboardNavigationSequence);
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const [viewMode, setViewMode] = useState<"fit" | "zoom">("fit");
  const [scale, setScale] = useState(1);
  const hasNavigation = Boolean(navigation);
  const [navigationChrome, setNavigationChrome] = useState<
    "all" | "hidden" | "position"
  >(() => (hasNavigation ? initialNavigationChrome : "hidden"));

  const clearNavigationHideTimer = useCallback(() => {
    if (navigationHideTimerRef.current !== null) {
      window.clearTimeout(navigationHideTimerRef.current);
      navigationHideTimerRef.current = null;
    }
  }, []);

  const scheduleNavigationChromeHide = useCallback(
    (delay = IMAGE_VIEWER_NAVIGATION_IDLE_MS) => {
      clearNavigationHideTimer();
      navigationHideTimerRef.current = window.setTimeout(() => {
        navigationHideTimerRef.current = null;
        if (!navigationFocusWithinRef.current) {
          setNavigationChrome("hidden");
        }
      }, delay);
    },
    [clearNavigationHideTimer],
  );

  const revealNavigationChrome = useCallback(
    (
      mode: "all" | "position",
      delay = IMAGE_VIEWER_NAVIGATION_IDLE_MS,
    ) => {
      if (!hasNavigation) {
        return;
      }
      setNavigationChrome(
        mode === "position" && navigationFocusWithinRef.current ? "all" : mode,
      );
      scheduleNavigationChromeHide(delay);
    },
    [hasNavigation, scheduleNavigationChromeHide],
  );

  useEffect(() => {
    if (!hasNavigation) {
      clearNavigationHideTimer();
      setNavigationChrome("hidden");
      return;
    }
    revealNavigationChrome(initialNavigationChrome);
    return clearNavigationHideTimer;
  }, [
    clearNavigationHideTimer,
    hasNavigation,
    initialNavigationChrome,
    revealNavigationChrome,
  ]);

  useEffect(() => {
    if (
      keyboardNavigationSequenceRef.current === keyboardNavigationSequence
    ) {
      return;
    }
    keyboardNavigationSequenceRef.current = keyboardNavigationSequence;
    revealNavigationChrome("position");
  }, [keyboardNavigationSequence, revealNavigationChrome]);

  const getFitScale = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !dimensions) {
      return 1;
    }
    return Math.min(
      1,
      Math.max(
        IMAGE_ZOOM_MIN,
        (stage.clientWidth - IMAGE_VIEWER_PADDING_PX) / dimensions.width,
      ),
      Math.max(
        IMAGE_ZOOM_MIN,
        (stage.clientHeight - IMAGE_VIEWER_PADDING_PX) / dimensions.height,
      ),
    );
  }, [dimensions]);

  const getCurrentScale = useCallback(
    () => (viewMode === "fit" ? getFitScale() : scale),
    [getFitScale, scale, viewMode],
  );

  const zoomAt = useCallback(
    (requestedScale: number, clientX?: number, clientY?: number) => {
      const stage = stageRef.current;
      const nextScale = clampImageScale(requestedScale);
      if (!stage) {
        setViewMode("zoom");
        setScale(nextScale);
        return;
      }

      const currentScale = getCurrentScale();
      const rect = stage.getBoundingClientRect();
      const viewportX =
        clientX === undefined ? stage.clientWidth / 2 : clientX - rect.left;
      const viewportY =
        clientY === undefined ? stage.clientHeight / 2 : clientY - rect.top;
      const contentX = stage.scrollLeft + viewportX;
      const contentY = stage.scrollTop + viewportY;
      setViewMode("zoom");
      setScale(nextScale);

      requestAnimationFrame(() => {
        const ratio = nextScale / currentScale;
        stage.scrollLeft = contentX * ratio - viewportX;
        stage.scrollTop = contentY * ratio - viewportY;
      });
    },
    [getCurrentScale],
  );

  const fitImage = useCallback(() => {
    setViewMode("fit");
    requestAnimationFrame(() => {
      const stage = stageRef.current;
      if (stage) {
        stage.scrollLeft = 0;
        stage.scrollTop = 0;
      }
    });
  }, []);

  const startRemainingPointerPan = useCallback(() => {
    const stage = stageRef.current;
    const remaining = pointersRef.current.values().next().value;
    gestureRef.current =
      stage && remaining
        ? {
            kind: "pan",
            scrollLeft: stage.scrollLeft,
            scrollTop: stage.scrollTop,
            x: remaining.x,
            y: remaining.y,
          }
        : null;
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      const [first, second] = points;
      if (!first || !second) {
        return;
      }
      gestureRef.current = {
        distance: pointerDistance(first, second),
        kind: "pinch",
        scale: getCurrentScale(),
      };
      return;
    }
    startRemainingPointerPan();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== "touch" ||
      !pointersRef.current.has(event.pointerId)
    ) {
      return;
    }
    pointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    const points = Array.from(pointersRef.current.values());
    if (points.length >= 2) {
      event.preventDefault();
      const [first, second] = points;
      if (!first || !second) {
        return;
      }
      const gesture = gestureRef.current;
      if (gesture?.kind !== "pinch") {
        gestureRef.current = {
          distance: pointerDistance(first, second),
          kind: "pinch",
          scale: getCurrentScale(),
        };
        return;
      }
      const distance = pointerDistance(first, second);
      if (gesture.distance <= 0) {
        return;
      }
      suppressClickRef.current = true;
      zoomAt(
        gesture.scale * (distance / gesture.distance),
        (first.x + second.x) / 2,
        (first.y + second.y) / 2,
      );
      return;
    }

    const stage = stageRef.current;
    const gesture = gestureRef.current;
    const point = points[0];
    if (!point || gesture?.kind !== "pan") {
      return;
    }
    const dx = point.x - gesture.x;
    const dy = point.y - gesture.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) {
      suppressClickRef.current = true;
    }
    if (!stage || viewMode === "fit") {
      return;
    }
    stage.scrollLeft = gesture.scrollLeft - dx;
    stage.scrollTop = gesture.scrollTop - dy;
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }
    pointersRef.current.delete(event.pointerId);
    if (pointersRef.current.size === 0) {
      suppressClickRef.current = false;
    }
    startRemainingPointerPan();
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== "touch") {
      return;
    }
    pointersRef.current.delete(event.pointerId);
    const revealControls =
      pointersRef.current.size === 0 && !suppressClickRef.current;
    if (pointersRef.current.size === 0) {
      suppressClickRef.current = false;
    }
    startRemainingPointerPan();
    if (revealControls) {
      onNavigationInput?.("controls");
      revealNavigationChrome("all", IMAGE_VIEWER_NAVIGATION_TOUCH_IDLE_MS);
    }
  };

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) {
      return;
    }
    event.preventDefault();
    zoomAt(
      getCurrentScale() * Math.exp(-event.deltaY * 0.002),
      event.clientX,
      event.clientY,
    );
  };

  const scaledDimensions =
    viewMode === "zoom" && dimensions
      ? {
          height: Math.max(1, Math.round(dimensions.height * scale)),
          width: Math.max(1, Math.round(dimensions.width * scale)),
        }
      : null;
  const canvasStyle = scaledDimensions
    ? ({
        height: scaledDimensions.height + IMAGE_VIEWER_PADDING_PX,
        width: scaledDimensions.width + IMAGE_VIEWER_PADDING_PX,
      } satisfies CSSProperties)
    : undefined;
  const imageStyle = scaledDimensions
    ? ({
        height: scaledDimensions.height,
        width: scaledDimensions.width,
      } satisfies CSSProperties)
    : undefined;
  const zoomLabel = `${Math.round(getCurrentScale() * 100)}%`;

  return (
    <div
      className={`local-media-image-viewer${navigation ? " has-navigation" : ""}`}
    >
      <div
        className="local-media-image-toolbar"
        role="toolbar"
        aria-label={t("imageViewerControls")}
      >
        <button
          type="button"
          className="local-media-image-control"
          aria-pressed={viewMode === "fit"}
          onClick={fitImage}
        >
          {t("imageViewerFit")}
        </button>
        <button
          type="button"
          className="local-media-image-control"
          aria-pressed={viewMode === "zoom" && scale === 1}
          onClick={() => zoomAt(1)}
        >
          {t("imageViewerActualSize")}
        </button>
        <button
          type="button"
          className="local-media-image-control"
          aria-label={t("imageViewerZoomOut")}
          onClick={() => zoomAt(getCurrentScale() / IMAGE_ZOOM_STEP)}
        >
          −
        </button>
        <output className="local-media-image-zoom" aria-live="polite">
          {zoomLabel}
        </output>
        <button
          type="button"
          className="local-media-image-control"
          aria-label={t("imageViewerZoomIn")}
          onClick={() => zoomAt(getCurrentScale() * IMAGE_ZOOM_STEP)}
        >
          +
        </button>
        <a
          className="local-media-image-download"
          href={url}
          download={fileName}
          aria-label={t("imageViewerDownload", { name: fileName })}
        >
          {t("fileViewerDownload" as never)}
        </a>
        <button
          type="button"
          className="local-media-image-close"
          aria-label={t("imageViewerClose")}
          onClick={onClose}
        >
          {t("modalClose")}
        </button>
      </div>
      <div
        className="local-media-image-stage-shell"
        onPointerMoveCapture={(event) => {
          if (event.pointerType !== "touch") {
            onNavigationInput?.("controls");
            revealNavigationChrome("all");
          }
        }}
      >
        <div
          ref={stageRef}
          className={`local-media-image-stage is-${viewMode}`}
          onPointerCancel={handlePointerCancel}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onWheel={handleWheel}
        >
          <div className="local-media-image-canvas" style={canvasStyle}>
            <div className={`local-media-image-surface is-${viewMode}`}>
              <img
                className="local-media-image"
                src={url}
                alt={fileName}
                draggable={false}
                style={imageStyle}
                onLoad={(event) => {
                  setDimensions({
                    height: event.currentTarget.naturalHeight,
                    width: event.currentTarget.naturalWidth,
                  });
                }}
              />
            </div>
          </div>
        </div>
        {navigation ? (
          <div
            className={`local-media-image-navigation${navigationChrome === "all" ? " is-visible" : " is-hidden"}`}
            role="group"
            aria-label={t("imageViewerGalleryNavigation")}
            onFocusCapture={() => {
              onNavigationInput?.("controls");
              navigationFocusWithinRef.current = true;
              clearNavigationHideTimer();
              setNavigationChrome("all");
            }}
            onBlurCapture={(event) => {
              if (
                event.relatedTarget instanceof Node &&
                event.currentTarget.contains(event.relatedTarget)
              ) {
                return;
              }
              navigationFocusWithinRef.current = false;
              scheduleNavigationChromeHide();
            }}
          >
            <button
              type="button"
              className="local-media-image-navigation-button is-previous"
              aria-label={t("imageViewerPrevious")}
              onClick={() => {
                onNavigationInput?.("controls");
                revealNavigationChrome("all");
                navigation.onPrevious();
              }}
            >
              <ImageViewerChevron direction="previous" />
            </button>
            <button
              type="button"
              className="local-media-image-navigation-button is-next"
              aria-label={t("imageViewerNext")}
              onClick={() => {
                onNavigationInput?.("controls");
                revealNavigationChrome("all");
                navigation.onNext();
              }}
            >
              <ImageViewerChevron direction="next" />
            </button>
          </div>
        ) : null}
      </div>
      {navigation ? (
        <output
          className={`local-media-image-position${navigationChrome === "hidden" ? " is-hidden" : " is-visible"}`}
          aria-live="polite"
        >
          {t("imageViewerGalleryPosition", {
            count: navigation.count,
            current: navigation.current,
          })}
        </output>
      ) : null}
    </div>
  );
}
