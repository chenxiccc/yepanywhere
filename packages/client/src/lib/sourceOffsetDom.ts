export const SOURCE_OFFSET_START_ATTR = "data-ya-source-start";
export const SOURCE_OFFSET_END_ATTR = "data-ya-source-end";

export interface SourceOffsetRange {
  start: number;
  end: number;
}

function readElementOffsets(element: Element): SourceOffsetRange | null {
  const start = Number(element.getAttribute(SOURCE_OFFSET_START_ATTR));
  const end = Number(element.getAttribute(SOURCE_OFFSET_END_ATTR));
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    return null;
  }
  return { start, end };
}

function annotatedAncestor(node: Node, root: HTMLElement): HTMLElement | null {
  const element =
    node instanceof HTMLElement ? node : (node.parentElement ?? null);
  const annotated = element?.closest<HTMLElement>(
    `[${SOURCE_OFFSET_START_ATTR}][${SOURCE_OFFSET_END_ATTR}]`,
  );
  return annotated && root.contains(annotated) ? annotated : null;
}

function textLengthBeforeBoundary(
  element: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  try {
    range.setEnd(container, offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

function sourceOffsetForBoundary(
  root: HTMLElement,
  container: Node,
  offset: number,
): number | null {
  const annotated = annotatedAncestor(container, root);
  const offsets = annotated ? readElementOffsets(annotated) : null;
  if (!annotated || !offsets) return null;
  const textOffset = textLengthBeforeBoundary(annotated, container, offset);
  if (textOffset === null) return null;
  const sourceOffset = offsets.start + textOffset;
  return sourceOffset <= offsets.end ? sourceOffset : null;
}

export function getRangeSourceOffsets(
  root: HTMLElement,
  range: Range,
): SourceOffsetRange | null {
  const start = sourceOffsetForBoundary(
    root,
    range.startContainer,
    range.startOffset,
  );
  const end = sourceOffsetForBoundary(
    root,
    range.endContainer,
    range.endOffset,
  );
  return start !== null && end !== null && end >= start ? { start, end } : null;
}

interface TextBoundary {
  node: Text;
  offset: number;
}

function textBoundaryAt(
  element: HTMLElement,
  relativeOffset: number,
): TextBoundary | null {
  const walker = element.ownerDocument.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
  );
  let consumed = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const length = textNode.data.length;
    if (relativeOffset <= consumed + length) {
      return { node: textNode, offset: relativeOffset - consumed };
    }
    consumed += length;
  }
  return null;
}

function annotatedBoundaryAt(
  root: HTMLElement,
  sourceOffset: number,
  side: "end" | "start",
): TextBoundary | null {
  let best:
    | { element: HTMLElement; offsets: SourceOffsetRange; span: number }
    | undefined;
  for (const element of root.querySelectorAll<HTMLElement>(
    `[${SOURCE_OFFSET_START_ATTR}][${SOURCE_OFFSET_END_ATTR}]`,
  )) {
    const offsets = readElementOffsets(element);
    if (!offsets) continue;
    const containsOffset =
      side === "start"
        ? sourceOffset >= offsets.start && sourceOffset < offsets.end
        : sourceOffset > offsets.start && sourceOffset <= offsets.end;
    const span = offsets.end - offsets.start;
    if (containsOffset && (!best || span < best.span)) {
      best = { element, offsets, span };
    }
  }
  return best
    ? textBoundaryAt(best.element, sourceOffset - best.offsets.start)
    : null;
}

export function createRangeFromSourceOffsets(
  root: HTMLElement,
  sourceRange: SourceOffsetRange,
): Range | null {
  if (sourceRange.end <= sourceRange.start) return null;
  const start = annotatedBoundaryAt(root, sourceRange.start, "start");
  const end = annotatedBoundaryAt(root, sourceRange.end, "end");
  if (!start || !end) return null;
  const range = root.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}
