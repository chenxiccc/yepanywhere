import { getPathBasename } from "./text";
import type { RenderItem } from "../types/renderItems";

const INLINE_IMAGE_LINK_SELECTOR =
  'a.local-media-link[data-media-type="image"], a.local-media-link[data-ya-media-type="image"]';

export interface TurnInlineImage {
  basename: string;
  id: string;
  label: string;
  originalIndex: number;
  path: string;
  sourceIndex: number;
  sourceItemId: string;
}

export interface GalleryImageDimensions {
  height: number;
  width: number;
}

export interface GalleryLayoutItem {
  height: number;
  id: string;
  width: number;
}

export interface GalleryLayoutRow {
  height: number;
  items: GalleryLayoutItem[];
}

function inlineImageId(sourceItemId: string, sourceIndex: number): string {
  return `${sourceItemId}:inline-image:${sourceIndex}`;
}

function getInlineImageAnchors(root: ParentNode): HTMLAnchorElement[] {
  return Array.from(
    root.querySelectorAll<HTMLAnchorElement>(INLINE_IMAGE_LINK_SELECTOR),
  );
}

function getInlineImagePath(anchor: HTMLAnchorElement): string | null {
  const dataPath =
    anchor.getAttribute("data-ya-path") ??
    anchor
      .closest(".local-media-link-group")
      ?.querySelector<HTMLElement>("[data-media-path]")
      ?.getAttribute("data-media-path");
  if (dataPath) {
    return dataPath;
  }

  try {
    return new URL(anchor.href, window.location.href).searchParams.get("path");
  } catch {
    return null;
  }
}

function getInlineImageLabel(anchor: HTMLAnchorElement, path: string): string {
  const copy = anchor.cloneNode(true) as HTMLAnchorElement;
  copy.querySelector(".local-media-type")?.remove();
  return copy.textContent?.trim() || getPathBasename(path);
}

function extractTextItemImages(
  item: Extract<RenderItem, { type: "text" }>,
  originalIndexOffset: number,
): TurnInlineImage[] {
  if (!item.augmentHtml || typeof document === "undefined") {
    return [];
  }

  const template = document.createElement("template");
  template.innerHTML = item.augmentHtml;
  const images: TurnInlineImage[] = [];
  for (const [sourceIndex, anchor] of getInlineImageAnchors(
    template.content,
  ).entries()) {
    const path = getInlineImagePath(anchor);
    if (!path) {
      continue;
    }
    images.push({
      basename: getPathBasename(path),
      id: inlineImageId(item.id, sourceIndex),
      label: getInlineImageLabel(anchor, path),
      originalIndex: originalIndexOffset + images.length,
      path,
      sourceIndex,
      sourceItemId: item.id,
    });
  }
  return images;
}

export function collectTurnInlineImages(
  items: readonly RenderItem[],
): TurnInlineImage[] {
  const images: TurnInlineImage[] = [];
  for (const item of items) {
    if (item.type !== "text") {
      continue;
    }
    images.push(...extractTextItemImages(item, images.length));
  }
  return images;
}

export function getTurnInlineImageIdForTarget(
  root: ParentNode,
  sourceItemId: string,
  target: EventTarget | null,
): string | null {
  if (!(target instanceof Element)) {
    return null;
  }
  const control = target.closest(
    `${INLINE_IMAGE_LINK_SELECTOR}, button.local-media-inline-toggle[data-media-type="image"]`,
  );
  if (!control || !root.contains(control)) {
    return null;
  }
  const anchor =
    control instanceof HTMLAnchorElement
      ? control
      : control
          .closest(".local-media-link-group")
          ?.querySelector<HTMLAnchorElement>(INLINE_IMAGE_LINK_SELECTOR);
  if (!anchor) {
    return null;
  }
  const sourceIndex = getInlineImageAnchors(root).indexOf(anchor);
  return sourceIndex >= 0 ? inlineImageId(sourceItemId, sourceIndex) : null;
}

export function findTurnInlineImageAnchor(
  root: ParentNode,
  sourceIndex: number,
): HTMLAnchorElement | null {
  return getInlineImageAnchors(root)[sourceIndex] ?? null;
}

function validAspectRatio(dimensions: GalleryImageDimensions | undefined) {
  if (
    !dimensions ||
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    return 4 / 3;
  }
  return Math.max(0.2, Math.min(5, dimensions.width / dimensions.height));
}

interface GalleryAspectImage {
  aspect: number;
  id: string;
  originalIndex: number;
}

function packGalleryRowCount(
  images: readonly GalleryAspectImage[],
  rowCount: number,
  availableWidth: number,
  maxHeight: number,
  gap: number,
): GalleryLayoutRow[] {
  const rows = Array.from({ length: rowCount }, () => ({
    aspectSum: 0,
    images: [] as GalleryAspectImage[],
  }));
  for (const image of images) {
    let target = rows[0];
    if (!target) {
      continue;
    }
    for (const row of rows.slice(1)) {
      if (row.aspectSum < target.aspectSum) {
        target = row;
      }
    }
    target.images.push(image);
    target.aspectSum += image.aspect;
  }

  const usableHeight = Math.max(1, maxHeight - gap * (rowCount - 1));
  const perRowHeight = usableHeight / rowCount;
  return rows
    .filter((row) => row.images.length > 0)
    .map((row) => {
      const usableWidth = Math.max(
        1,
        availableWidth - gap * (row.images.length - 1),
      );
      const height = Math.max(
        1,
        Math.min(perRowHeight, usableWidth / row.aspectSum),
      );
      return {
        height,
        items: row.images.map((image) => ({
          height,
          id: image.id,
          width: image.aspect * height,
        })),
      };
    });
}

/**
 * Stable justified-row packing. Compare a small bounded set of row counts and
 * choose the one with the largest minimum thumbnail height. Iterating upward
 * means equally legible layouts keep the fewer-row arrangement.
 */
export function packTurnGalleryRows(
  images: readonly Pick<TurnInlineImage, "id" | "originalIndex">[],
  dimensions: ReadonlyMap<string, GalleryImageDimensions>,
  availableWidth: number,
  maxHeight: number,
  gap = 8,
): GalleryLayoutRow[] {
  if (images.length === 0 || availableWidth <= 0 || maxHeight <= 0) {
    return [];
  }

  const sorted = images
    .map((image) => ({
      ...image,
      aspect: validAspectRatio(dimensions.get(image.id)),
    }))
    .sort(
      (left, right) =>
        right.aspect - left.aspect || left.originalIndex - right.originalIndex,
    );

  let bestLayout: GalleryLayoutRow[] = [];
  let bestMinimumHeight = 0;
  const maximumRowCount = Math.min(3, images.length);
  for (let rowCount = 1; rowCount <= maximumRowCount; rowCount += 1) {
    const layout = packGalleryRowCount(
      sorted,
      rowCount,
      availableWidth,
      maxHeight,
      gap,
    );
    const minimumHeight = Math.min(...layout.map((row) => row.height));
    if (minimumHeight > bestMinimumHeight) {
      bestLayout = layout;
      bestMinimumHeight = minimumHeight;
    }
  }
  return bestLayout;
}
