/**
 * Vector images are the one media class that can arrive with no suggested size.
 * A raster image's pixel dimensions are its suggested size; an SVG only has one
 * when its root element declares absolute `width` and `height`. A `viewBox`
 * alone carries an aspect ratio and nothing else, so the surrounding layout has
 * to supply the box — otherwise the figure has no width to derive and collapses
 * inside a shrink-to-fit container.
 */

export const SVG_CONTENT_TYPE = "image/svg+xml";

/** How much size information an image carries into layout. */
export type ImageSizing = "raster" | "vector-sized" | "vector-unsized";

/** Bytes read from an SVG when looking for its root element. */
const SVG_ROOT_SCAN_BYTES = 8192;

const SVG_ROOT_TAG = /<svg\b[^>]*>/i;

/**
 * An absolute length usable as a suggested size. Percentages are excluded:
 * `width="100%"` defers to the container exactly like no width at all.
 */
const ABSOLUTE_LENGTH = /^\+?\d*\.?\d+(px|pt|pc|cm|mm|in|q|em|ex|rem)?$/i;

export function isVectorImage(
  contentType: string | undefined,
  fileName: string,
): boolean {
  const normalized = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  return (
    normalized === SVG_CONTENT_TYPE ||
    (!normalized && fileName.toLowerCase().endsWith(".svg"))
  );
}

function declaresAbsoluteLength(rootTag: string, attribute: string): boolean {
  const value = new RegExp(
    `\\s${attribute}\\s*=\\s*"([^"]*)"|\\s${attribute}\\s*=\\s*'([^']*)'`,
    "i",
  ).exec(rootTag);
  const length = (value?.[1] ?? value?.[2] ?? "").trim();
  return length.length > 0 && ABSOLUTE_LENGTH.test(length);
}

/**
 * Whether an SVG source declares a suggested size on its root element. Both
 * dimensions are required: one alone leaves the other to the container, which
 * is the same layout problem as declaring neither.
 */
export function svgDeclaresSize(source: string): boolean {
  const rootTag = SVG_ROOT_TAG.exec(source)?.[0];
  if (!rootTag) {
    return false;
  }
  return (
    declaresAbsoluteLength(rootTag, "width") &&
    declaresAbsoluteLength(rootTag, "height")
  );
}

/**
 * Classify a fetched image. Only SVG is read as text, and only far enough to
 * reach its root element.
 */
export async function describeImageSizing(
  blob: Blob,
  fileName: string,
): Promise<ImageSizing> {
  if (!isVectorImage(blob.type, fileName)) {
    return "raster";
  }
  try {
    const head = await blob.slice(0, SVG_ROOT_SCAN_BYTES).text();
    return svgDeclaresSize(head) ? "vector-sized" : "vector-unsized";
  } catch {
    return "vector-unsized";
  }
}
