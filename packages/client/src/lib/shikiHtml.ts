import {
  SOURCE_OFFSET_END_ATTR,
  SOURCE_OFFSET_START_ATTR,
} from "./sourceOffsetDom";

export function compactShikiLineBreaks(
  html: string | undefined,
): string | undefined {
  if (!html) {
    return html;
  }
  return html.replace(/<\/span>\r?\n(?=<span class="line(?:\s|"))/g, "</span>");
}

interface SourceLineSlice {
  start: number;
  end: number;
  text: string;
}

function splitSourceLineSlices(source: string): SourceLineSlice[] {
  const lines: SourceLineSlice[] = [];
  let start = 0;
  const newlinePattern = /\r\n|\r|\n/g;
  for (
    let match = newlinePattern.exec(source);
    match;
    match = newlinePattern.exec(source)
  ) {
    const end = match.index;
    lines.push({ start, end, text: source.slice(start, end) });
    start = match.index + match[0].length;
  }
  lines.push({ start, end: source.length, text: source.slice(start) });
  return lines;
}

function setSourceOffsets(element: Element, start: number, end: number): void {
  element.setAttribute(SOURCE_OFFSET_START_ATTR, String(start));
  element.setAttribute(SOURCE_OFFSET_END_ATTR, String(end));
}

function annotateLineTokens(
  lineElement: HTMLElement,
  line: SourceLineSlice,
): void {
  const elementOffsets = new Map<HTMLElement, { start: number; end: number }>();
  const walker = lineElement.ownerDocument.createTreeWalker(
    lineElement,
    NodeFilter.SHOW_TEXT,
  );
  let cursor = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    const text = textNode.data;
    if (line.text.slice(cursor, cursor + text.length) !== text) {
      return;
    }
    const textStart = line.start + cursor;
    const textEnd = textStart + text.length;
    for (
      let element = textNode.parentElement;
      element && element !== lineElement;
      element = element.parentElement
    ) {
      const offsets = elementOffsets.get(element);
      elementOffsets.set(element, {
        start: offsets ? Math.min(offsets.start, textStart) : textStart,
        end: offsets ? Math.max(offsets.end, textEnd) : textEnd,
      });
    }
    cursor += text.length;
  }
  if (cursor !== line.text.length) return;

  for (const [element, offsets] of elementOffsets) {
    setSourceOffsets(element, offsets.start, offsets.end);
  }
}

/**
 * Carry exact source offsets through Shiki's block-per-line DOM. Shiki line
 * separators are layout, not text nodes, so selections spanning lines need
 * these offsets to recover source newlines and stable comment anchors.
 */
export function annotateShikiSourceOffsets(
  html: string | undefined,
  source: string | undefined,
): string | undefined {
  if (!html || source === undefined || typeof document === "undefined") {
    return html;
  }
  const template = document.createElement("template");
  template.innerHTML = compactShikiLineBreaks(html) ?? "";
  const renderedLines = Array.from(
    template.content.querySelectorAll<HTMLElement>("code .line"),
  );
  const sourceLines = splitSourceLineSlices(source);
  for (let index = 0; index < renderedLines.length; index += 1) {
    const lineElement = renderedLines[index];
    const line = sourceLines[index];
    if (!lineElement || !line || lineElement.textContent !== line.text) {
      continue;
    }
    setSourceOffsets(lineElement, line.start, line.end);
    annotateLineTokens(lineElement, line);
  }
  return template.innerHTML;
}
