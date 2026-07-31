const FALLBACK_BLAME_GUTTER_WIDTH = 68;
const FALLBACK_LINE_NUMBER_WIDTH = 44;
const FALLBACK_SCROLLBAR_AND_BORDER_WIDTH = 2;
const MAX_CACHED_LINE_WIDTHS = 128;

export const MIN_BLAME_DETAIL_WIDTH = 320;

interface BlameLineWidthCacheKey {
  projectId: string;
  path: string;
  lines: readonly string[];
  typography: string;
}

const maxLineWidths = new Map<string, number>();

/**
 * Identify the rendered content without retaining another copy of the file in
 * the width cache. The line count and UTF-16 length make the small hash useful
 * for invalidation rather than content addressing.
 */
export function createBlameLineWidthCacheKey({
  projectId,
  path,
  lines,
  typography,
}: BlameLineWidthCacheKey): string {
  let hash = 2166136261;
  let length = 0;
  for (const line of lines) {
    for (let index = 0; index < line.length; index += 1) {
      hash ^= line.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 10;
    hash = Math.imul(hash, 16777619);
    length += line.length + 1;
  }
  return `${projectId}\0${path}\0${lines.length}:${length}:${hash >>> 0}\0${typography}`;
}

export function getBlameTypographySignature(
  element: HTMLElement,
  revision = 0,
): string {
  const style = getComputedStyle(element);
  return [
    style.fontFamily,
    style.fontSize,
    style.lineHeight,
    style.fontWeight,
    style.fontStretch,
    style.fontVariationSettings,
    style.letterSpacing,
    style.getPropertyValue("tab-size"),
    revision,
  ].join("|");
}

/**
 * Read the intrinsic code width once per content/typography identity. Browser
 * scrollWidth accounts for tabs, wide characters, and the selected monospace
 * font more accurately than a character-count approximation.
 */
export function getCachedBlameMaxLineWidth(
  key: string,
  measure: () => number,
): number {
  const cached = maxLineWidths.get(key);
  if (cached !== undefined) {
    maxLineWidths.delete(key);
    maxLineWidths.set(key, cached);
    return cached;
  }

  const measured = Math.max(0, Math.ceil(measure()));
  maxLineWidths.set(key, measured);
  while (maxLineWidths.size > MAX_CACHED_LINE_WIDTHS) {
    const oldest = maxLineWidths.keys().next().value;
    if (oldest === undefined) break;
    maxLineWidths.delete(oldest);
  }
  return measured;
}

export function measureBlameDetailWidth(
  container: HTMLElement,
  cacheKey: string,
): number {
  // The blame grid is addressed by stable data attributes rather than class
  // names: `BlameView` styles those elements through a hashed CSS Module.
  const codeCells = Array.from(
    container.querySelectorAll<HTMLElement>("[data-blame-code]"),
  );
  const maxLineWidth = getCachedBlameMaxLineWidth(cacheKey, () =>
    codeCells.reduce(
      (maximum, cell) => Math.max(maximum, measureRenderedLineWidth(cell)),
      0,
    ),
  );
  const firstRow = container.querySelector<HTMLElement>("[data-blame-row]");
  const gutterWidth =
    firstRow?.querySelector<HTMLElement>("[data-blame-gutter]")?.offsetWidth ||
    FALLBACK_BLAME_GUTTER_WIDTH;
  const lineNumberWidth =
    firstRow?.querySelector<HTMLElement>("[data-blame-lineno]")?.offsetWidth ||
    FALLBACK_LINE_NUMBER_WIDTH;
  const scrollbarAndBorderWidth =
    container.offsetWidth - container.clientWidth ||
    FALLBACK_SCROLLBAR_AND_BORDER_WIDTH;

  return Math.max(
    MIN_BLAME_DETAIL_WIDTH,
    Math.ceil(
      gutterWidth + lineNumberWidth + maxLineWidth + scrollbarAndBorderWidth,
    ),
  );
}

function measureRenderedLineWidth(cell: HTMLElement): number {
  const range = document.createRange();
  range.selectNodeContents(cell);
  const renderedWidth = range.getBoundingClientRect?.().width ?? 0;
  range.detach();
  // jsdom and older browser shims do not expose Range geometry. scrollWidth is
  // the best fallback there; real browsers use the text range so a short line
  // is not mistaken for its stretched grid-cell width.
  return renderedWidth > 0 ? renderedWidth : cell.scrollWidth;
}

export function resetBlameLineWidthCacheForTests(): void {
  maxLineWidths.clear();
}

export function getBlameLineWidthCacheSizeForTests(): number {
  return maxLineWidths.size;
}
