import {
  createContext,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildPublicShareRawFileApiPath,
  usePublicShareContext,
} from "../contexts/PublicShareContext";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import { useInlineMedia } from "../hooks/useInlineMedia";
import { useI18n } from "../i18n";
import { fetchPublicShareBlobViaRelay } from "../lib/publicShareRelay";
import {
  collectTurnInlineImages,
  findTurnInlineImageAnchor,
  type GalleryImageDimensions,
  packTurnGalleryRows,
  type TurnInlineImage,
} from "../lib/turnInlineMedia";
import type { RenderItem } from "../types/renderItems";
import {
  fetchLocalMediaBlob,
  LocalMediaModal,
  type LocalMediaSource,
} from "./LocalMediaModal";

interface TurnImageGalleryNavigation {
  activate: (id: string) => void;
  available: boolean;
  candidateIds: ReadonlySet<string>;
  closedActionTarget: TurnInlineImage | null;
  show: () => void;
}

const TurnImageGalleryContext =
  createContext<TurnImageGalleryNavigation | null>(null);

export function useTurnImageGalleryNavigation() {
  return useContext(TurnImageGalleryContext);
}

interface AssistantTurnImageGalleryProps {
  children: ReactNode;
  items: readonly RenderItem[];
}

interface GalleryThumbnailProps {
  candidate: TurnInlineImage;
  featured: boolean;
  mediaSource?: LocalMediaSource;
  onDimensions: (id: string, dimensions: GalleryImageDimensions) => void;
  onFeature: (id: string) => void;
  onOpen: (candidate: TurnInlineImage) => void;
  registerElement: (id: string, element: HTMLElement | null) => void;
  style: CSSProperties;
}

function useGalleryMediaSource(): LocalMediaSource | undefined {
  const publicShare = usePublicShareContext();
  return useMemo(() => {
    if (!publicShare) {
      return undefined;
    }
    return {
      buildApiPath: (path) => buildPublicShareRawFileApiPath(publicShare, path),
      fetchBlob: async (_path, apiPath) =>
        await fetchPublicShareBlobViaRelay({
          path: apiPath,
          relayUrl: publicShare.relayUrl,
          relayUsername: publicShare.relayUsername,
        }),
    };
  }, [publicShare]);
}

function GalleryThumbnail({
  candidate,
  featured,
  mediaSource,
  onDimensions,
  onFeature,
  onOpen,
  registerElement,
  style,
}: GalleryThumbnailProps) {
  const { t } = useI18n();
  const transport = useCurrentSourceRuntime().transport;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    setImageUrl(null);
    setError(false);
    void fetchLocalMediaBlob(candidate.path, mediaSource, "inline", transport)
      .then((blob) => {
        if (cancelled) {
          return;
        }
        objectUrl = URL.createObjectURL(blob);
        setImageUrl(objectUrl);
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
        }
      });
    return () => {
      cancelled = true;
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [candidate.path, mediaSource, transport]);

  return (
    <div
      ref={(element) => registerElement(candidate.id, element)}
      className={`turn-image-gallery-item${featured ? " is-featured" : ""}`}
      data-gallery-image-id={candidate.id}
      role="group"
      aria-label={candidate.label}
      style={style}
      tabIndex={-1}
      onFocus={() => onFeature(candidate.id)}
      onPointerEnter={() => onFeature(candidate.id)}
    >
      <button
        type="button"
        className="turn-image-gallery-thumbnail"
        aria-label={t("turnImageGalleryOpen", { label: candidate.label })}
        onClick={() => onOpen(candidate)}
      >
        {imageUrl ? (
          <img
            src={imageUrl}
            alt={candidate.label}
            draggable={false}
            onLoad={(event) => {
              const { naturalHeight, naturalWidth } = event.currentTarget;
              onDimensions(candidate.id, {
                height: naturalHeight,
                width: naturalWidth,
              });
            }}
          />
        ) : (
          <span className="turn-image-gallery-placeholder">
            {error
              ? t("turnImageGalleryUnavailable")
              : t("turnImageGalleryLoading")}
          </span>
        )}
      </button>
    </div>
  );
}

export function AssistantTurnImageGallery({
  children,
  items,
}: AssistantTurnImageGalleryProps) {
  const { t } = useI18n();
  const { compactMultiImageGalleries, inlineMediaExpandedByDefault } =
    useInlineMedia();
  const candidates = useMemo(() => collectTurnInlineImages(items), [items]);
  const candidateSignature = candidates
    .map((candidate) => candidate.id)
    .join("\0");
  const candidateIds = useMemo(
    () => new Set(candidates.map((candidate) => candidate.id)),
    [candidates],
  );
  const galleryAvailable = compactMultiImageGalleries && candidates.length >= 2;
  const [dismissed, setDismissed] = useState(false);
  const [manuallyOpened, setManuallyOpened] = useState(false);
  const [featuredId, setFeaturedId] = useState(candidates[0]?.id ?? "");
  const [selectedImage, setSelectedImage] = useState<TurnInlineImage | null>(
    null,
  );
  const [dimensions, setDimensions] = useState(
    () => new Map<string, GalleryImageDimensions>(),
  );
  const [layoutBounds, setLayoutBounds] = useState({
    height: 240,
    width: 720,
  });
  const turnRef = useRef<HTMLDivElement>(null);
  const galleryRowsRef = useRef<HTMLDivElement>(null);
  const thumbnailElementsRef = useRef(new Map<string, HTMLElement>());
  const pendingCenterIdRef = useRef<string | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const pointerPositionRef = useRef<{
    clientX: number;
    clientY: number;
  } | null>(null);
  const mediaSource = useGalleryMediaSource();
  const galleryActive =
    galleryAvailable &&
    !dismissed &&
    (inlineMediaExpandedByDefault || manuallyOpened);

  useEffect(() => {
    if (!candidateIds.has(featuredId)) {
      setFeaturedId(candidates[0]?.id ?? "");
    }
  }, [candidateIds, candidates, featuredId]);

  useLayoutEffect(() => {
    const rows = galleryRowsRef.current;
    if (!rows || !galleryActive) {
      return;
    }
    const measure = () => {
      const viewportHeight = window.innerHeight;
      setLayoutBounds({
        height: Math.max(120, Math.min(320, viewportHeight / 3 - 48)),
        width: Math.max(1, rows.clientWidth),
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(rows);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [galleryActive]);

  const centerGalleryImage = useCallback((id: string) => {
    setFeaturedId(id);
    const element = thumbnailElementsRef.current.get(id);
    if (!element) {
      pendingCenterIdRef.current = id;
      return;
    }
    element.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "center",
    });
    element.focus({ preventScroll: true });
    pendingCenterIdRef.current = null;
  }, []);

  const activateGallery = useCallback(
    (id: string) => {
      if (!candidateIds.has(id)) {
        return;
      }
      pendingCenterIdRef.current = id;
      setFeaturedId(id);
      setManuallyOpened(true);
      setDismissed(false);
      if (galleryActive) {
        centerGalleryImage(id);
      }
    },
    [candidateIds, centerGalleryImage, galleryActive],
  );

  const showGallery = useCallback(() => {
    if (!galleryAvailable) {
      return;
    }
    const id = candidateIds.has(featuredId) ? featuredId : candidates[0]?.id;
    if (id) {
      pendingCenterIdRef.current = id;
      setFeaturedId(id);
    }
    setManuallyOpened(true);
    setDismissed(false);
  }, [candidateIds, candidates, featuredId, galleryAvailable]);

  useLayoutEffect(() => {
    if (galleryActive && pendingCenterIdRef.current) {
      centerGalleryImage(pendingCenterIdRef.current);
    }
  }, [centerGalleryImage, galleryActive]);

  const jumpToSource = useCallback((candidate: TurnInlineImage) => {
    const turn = turnRef.current;
    if (!turn) {
      return;
    }
    const source = Array.from(
      turn.querySelectorAll<HTMLElement>("[data-turn-image-source-id]"),
    ).find(
      (element) => element.dataset.turnImageSourceId === candidate.sourceItemId,
    );
    const anchor = source
      ? findTurnInlineImageAnchor(source, candidate.sourceIndex)
      : null;
    if (!anchor) {
      return;
    }
    anchor.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest",
    });
    anchor.focus({ preventScroll: true });
  }, []);

  const layout = useMemo(
    () =>
      packTurnGalleryRows(
        candidates,
        dimensions,
        layoutBounds.width,
        layoutBounds.height,
      ),
    [candidates, dimensions, layoutBounds],
  );
  const layoutById = useMemo(
    () =>
      new Map(
        layout.flatMap((row) =>
          row.items.map((item) => [
            item.id,
            { height: item.height, width: item.width },
          ]),
        ),
      ),
    [layout],
  );
  const featured =
    candidates.find((candidate) => candidate.id === featuredId) ??
    candidates[0];
  const closedActionTarget =
    galleryAvailable && !galleryActive
      ? (candidates[candidates.length - 1] ?? null)
      : null;
  const navigation = useMemo<TurnImageGalleryNavigation>(
    () => ({
      activate: activateGallery,
      available: galleryAvailable,
      candidateIds,
      closedActionTarget,
      show: showGallery,
    }),
    [
      activateGallery,
      candidateIds,
      closedActionTarget,
      galleryAvailable,
      showGallery,
    ],
  );

  const updateCenteredImage = useCallback(() => {
    scrollFrameRef.current = null;
    const rows = galleryRowsRef.current;
    if (!rows) {
      return;
    }
    const center = rows.getBoundingClientRect().left + rows.clientWidth / 2;
    let closest: { distance: number; id: string } | null = null;
    for (const [id, element] of thumbnailElementsRef.current) {
      const rect = element.getBoundingClientRect();
      const distance = Math.abs(rect.left + rect.width / 2 - center);
      if (!closest || distance < closest.distance) {
        closest = { distance, id };
      }
    }
    if (closest) {
      setFeaturedId(closest.id);
    }
  }, []);

  const featureNearestPointerImage = useCallback(
    (clientX: number, clientY: number) => {
      let closest: {
        centerDistance: number;
        edgeDistance: number;
        id: string;
      } | null = null;
      for (const [id, element] of thumbnailElementsRef.current) {
        const rect = element.getBoundingClientRect();
        const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
        const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
        const edgeDistance = dx * dx + dy * dy;
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const centerDistance =
          (centerX - clientX) ** 2 + (centerY - clientY) ** 2;
        if (
          !closest ||
          edgeDistance < closest.edgeDistance ||
          (edgeDistance === closest.edgeDistance &&
            centerDistance < closest.centerDistance)
        ) {
          closest = { centerDistance, edgeDistance, id };
        }
      }
      if (closest) {
        setFeaturedId(closest.id);
      }
    },
    [],
  );

  const scheduleNearestPointerImage = useCallback(
    (clientX: number, clientY: number) => {
      pointerPositionRef.current = { clientX, clientY };
      if (pointerFrameRef.current !== null) {
        return;
      }
      pointerFrameRef.current = requestAnimationFrame(() => {
        pointerFrameRef.current = null;
        const position = pointerPositionRef.current;
        if (position) {
          featureNearestPointerImage(position.clientX, position.clientY);
        }
      });
    },
    [featureNearestPointerImage],
  );

  useEffect(
    () => () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
      }
      if (pointerFrameRef.current !== null) {
        cancelAnimationFrame(pointerFrameRef.current);
      }
    },
    [],
  );

  return (
    <TurnImageGalleryContext.Provider value={navigation}>
      <div
        ref={turnRef}
        className={`assistant-turn${galleryActive ? " has-turn-image-gallery" : ""}`}
      >
        {children}
        {galleryActive ? (
          <section
            className="turn-image-gallery"
            aria-label={t("turnImageGalleryLabel")}
            onPointerLeave={(event) => {
              if (event.pointerType !== "touch") {
                if (pointerFrameRef.current !== null) {
                  cancelAnimationFrame(pointerFrameRef.current);
                  pointerFrameRef.current = null;
                }
                pointerPositionRef.current = null;
                setFeaturedId(candidates[0]?.id ?? "");
              }
            }}
            onKeyDown={(event: KeyboardEvent<HTMLElement>) => {
              if (event.key === "Escape") {
                event.preventDefault();
                setDismissed(true);
              }
            }}
          >
            <div
              ref={galleryRowsRef}
              className="turn-image-gallery-rows"
              style={
                {
                  "--turn-gallery-max-height": `${layoutBounds.height}px`,
                } as CSSProperties
              }
              onScroll={() => {
                if (scrollFrameRef.current === null) {
                  scrollFrameRef.current =
                    requestAnimationFrame(updateCenteredImage);
                }
              }}
              onPointerMove={(event) => {
                if (event.pointerType !== "touch") {
                  scheduleNearestPointerImage(event.clientX, event.clientY);
                }
              }}
            >
              {layout.map((row, rowIndex) => (
                <div
                  key={`${candidateSignature}:row:${rowIndex}`}
                  className="turn-image-gallery-row"
                  style={{ height: row.height }}
                >
                  {row.items.map((layoutItem) => {
                    const candidate = candidates.find(
                      (image) => image.id === layoutItem.id,
                    );
                    if (!candidate) {
                      return null;
                    }
                    return (
                      <GalleryThumbnail
                        key={candidate.id}
                        candidate={candidate}
                        featured={candidate.id === featured?.id}
                        mediaSource={mediaSource}
                        onDimensions={(id, nextDimensions) => {
                          setDimensions((current) => {
                            const previous = current.get(id);
                            if (
                              previous?.width === nextDimensions.width &&
                              previous.height === nextDimensions.height
                            ) {
                              return current;
                            }
                            const next = new Map(current);
                            next.set(id, nextDimensions);
                            return next;
                          });
                        }}
                        onFeature={setFeaturedId}
                        onOpen={setSelectedImage}
                        registerElement={(id, element) => {
                          if (element) {
                            thumbnailElementsRef.current.set(id, element);
                          } else {
                            thumbnailElementsRef.current.delete(id);
                          }
                        }}
                        style={layoutById.get(candidate.id) ?? {}}
                      />
                    );
                  })}
                </div>
              ))}
            </div>
            <div className="turn-image-gallery-footer">
              {featured ? (
                <button
                  type="button"
                  className="turn-image-gallery-caption"
                  onClick={() => jumpToSource(featured)}
                >
                  <span>{featured.label}</span>
                  {featured.basename !== featured.label ? (
                    <small>{featured.basename}</small>
                  ) : null}
                </button>
              ) : null}
              <span className="turn-image-gallery-count">
                {t("turnImageGalleryCount", {
                  count: candidates.length,
                  current: Math.max(
                    1,
                    candidates.findIndex(
                      (candidate) => candidate.id === featured?.id,
                    ) + 1,
                  ),
                })}
              </span>
              <button
                type="button"
                className="turn-image-gallery-dismiss"
                aria-keyshortcuts="Escape"
                onClick={() => setDismissed(true)}
              >
                {t("turnImageGalleryDismiss")}
              </button>
            </div>
          </section>
        ) : null}
        {selectedImage ? (
          <LocalMediaModal
            path={selectedImage.path}
            mediaType="image"
            mediaSource={mediaSource}
            onClose={() => setSelectedImage(null)}
          />
        ) : null}
      </div>
    </TurnImageGalleryContext.Provider>
  );
}
