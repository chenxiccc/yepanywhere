import type { ParsedGlossaryTable } from "./types.js";

interface VisiblePiece {
  required: boolean;
  text: string;
}

function decodeEntity(entity: string): string {
  const lower = entity.toLowerCase();
  if (lower === "&amp;") return "&";
  if (lower === "&lt;") return "<";
  if (lower === "&gt;") return ">";
  if (lower === "&quot;") return '"';
  if (lower === "&apos;" || lower === "&#39;") return "'";
  const decimal = /^&#(\d+);$/.exec(lower);
  const hexadecimal = /^&#x([\da-f]+);$/.exec(lower);
  const codePoint = decimal
    ? Number.parseInt(decimal[1] ?? "", 10)
    : hexadecimal
      ? Number.parseInt(hexadecimal[1] ?? "", 16)
      : Number.NaN;
  if (Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
    return String.fromCodePoint(codePoint);
  }
  return entity;
}

function decodeEntities(text: string): string {
  return text.replace(
    /&(?:#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/gi,
    decodeEntity,
  );
}

function delimiterLengthAt(text: string, index: number, char: "`"): number {
  let length = 0;
  while (text[index + length] === char) length += 1;
  return length;
}

function findClosingDelimiter(
  text: string,
  start: number,
  delimiter: string,
): number {
  return text.indexOf(delimiter, start);
}

function appendPiece(
  pieces: VisiblePiece[],
  text: string,
  required: boolean,
): void {
  if (!text) return;
  const previous = pieces.at(-1);
  if (previous?.required === required) {
    previous.text += text;
  } else {
    pieces.push({ required, text });
  }
}

/**
 * Flatten the small inline-Markdown subset used by glossary cells while
 * retaining whether visible text came from strong emphasis.
 */
export function parseGlossaryInline(markdown: string): {
  hasBold: boolean;
  pieces: VisiblePiece[];
} {
  const pieces: VisiblePiece[] = [];
  let bold = false;
  let hasBold = false;

  for (let index = 0; index < markdown.length; ) {
    const char = markdown[index] ?? "";
    if (char === "\\" && index + 1 < markdown.length) {
      appendPiece(pieces, markdown[index + 1] ?? "", bold);
      index += 2;
      continue;
    }

    if (char === "`") {
      const length = delimiterLengthAt(markdown, index, "`");
      const delimiter = "`".repeat(length);
      const close = findClosingDelimiter(markdown, index + length, delimiter);
      if (close >= 0) {
        let content = markdown
          .slice(index + length, close)
          .replace(/\s+/g, " ");
        if (
          content.startsWith(" ") &&
          content.endsWith(" ") &&
          content.trim().length > 0
        ) {
          content = content.slice(1, -1);
        }
        appendPiece(pieces, content, bold);
        index = close + length;
        continue;
      }
    }

    const strongMarker = markdown.startsWith("**", index)
      ? "**"
      : markdown.startsWith("__", index)
        ? "__"
        : null;
    if (strongMarker) {
      bold = !bold;
      hasBold = true;
      index += strongMarker.length;
      continue;
    }

    if (char === "*" || char === "_" || char === "~") {
      index += markdown[index + 1] === char ? 2 : 1;
      continue;
    }

    if (char === "<") {
      const close = markdown.indexOf(">", index + 1);
      if (close >= 0) {
        const inside = markdown.slice(index + 1, close);
        if (/^\/?[A-Za-z][^>]*$/.test(inside)) {
          index = close + 1;
          continue;
        }
        if (/^(?:https?:\/\/|mailto:)/i.test(inside)) {
          appendPiece(pieces, inside, bold);
          index = close + 1;
          continue;
        }
      }
    }

    if (char === "[" || (char === "!" && markdown[index + 1] === "[")) {
      const labelStart = char === "!" ? index + 2 : index + 1;
      const labelEnd = markdown.indexOf("]", labelStart);
      if (labelEnd >= 0) {
        const nested = parseGlossaryInline(
          markdown.slice(labelStart, labelEnd),
        );
        hasBold ||= nested.hasBold;
        for (const piece of nested.pieces) {
          appendPiece(pieces, piece.text, bold || piece.required);
        }
        let next = labelEnd + 1;
        if (markdown[next] === "(") {
          const destinationEnd = markdown.indexOf(")", next + 1);
          if (destinationEnd >= 0) next = destinationEnd + 1;
        } else if (markdown[next] === "[") {
          const referenceEnd = markdown.indexOf("]", next + 1);
          if (referenceEnd >= 0) next = referenceEnd + 1;
        }
        index = next;
        continue;
      }
    }

    if (char === "&") {
      const entity = /^&(?:#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/i.exec(
        markdown.slice(index),
      )?.[0];
      if (entity) {
        appendPiece(pieces, decodeEntity(entity), bold);
        index += entity.length;
        continue;
      }
    }

    appendPiece(pieces, char, bold);
    index += 1;
  }

  return { hasBold, pieces };
}

export function flattenGlossaryInlineMarkdown(markdown: string): string {
  const visible = parseGlossaryInline(markdown)
    .pieces.map((piece) => piece.text)
    .join("");
  return decodeEntities(visible).replace(/\s+/g, " ").trim();
}

/** Split comma alternatives without treating escaped/code/nested commas as separators. */
export function splitGlossaryAlternatives(markdown: string): string[] {
  const alternatives: string[] = [];
  let start = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let bold = false;
  let codeDelimiter = "";

  for (let index = 0; index < markdown.length; index += 1) {
    const char = markdown[index] ?? "";
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "`") {
      const length = delimiterLengthAt(markdown, index, "`");
      const delimiter = "`".repeat(length);
      if (!codeDelimiter) codeDelimiter = delimiter;
      else if (codeDelimiter === delimiter) codeDelimiter = "";
      index += length - 1;
      continue;
    }
    if (codeDelimiter) continue;
    if (markdown.startsWith("**", index) || markdown.startsWith("__", index)) {
      bold = !bold;
      index += 1;
      continue;
    }
    if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === "," && !bold && bracketDepth === 0 && parenDepth === 0) {
      alternatives.push(markdown.slice(start, index).trim());
      start = index + 1;
    }
  }
  alternatives.push(markdown.slice(start).trim());
  return alternatives;
}

function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  const cells: string[] = [];
  let current = "";
  let codeDelimiter = "";
  let escaped = false;
  const start = trimmed.startsWith("|") ? 1 : 0;
  const end =
    trimmed.endsWith("|") && !trimmed.endsWith("\\|")
      ? trimmed.length - 1
      : trimmed.length;

  for (let index = start; index < end; index += 1) {
    const char = trimmed[index] ?? "";
    if (escaped) {
      current += `\\${char}`;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      const length = delimiterLengthAt(trimmed, index, "`");
      const delimiter = "`".repeat(length);
      if (!codeDelimiter) codeDelimiter = delimiter;
      else if (codeDelimiter === delimiter) codeDelimiter = "";
      current += delimiter;
      index += length - 1;
      continue;
    }
    if (char === "|" && !codeDelimiter) {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (escaped) current += "\\";
  cells.push(current.trim());
  return cells.length >= 2 ? cells : null;
}

function isDelimiterRow(cells: readonly string[]): boolean {
  return cells.length >= 2 && cells.every((cell) => /^:?-{1,}:?$/.test(cell));
}

/** Parse rows from the first Markdown table in a glossary document. */
export function parseFirstGlossaryTable(
  markdown: string,
): ParsedGlossaryTable | null {
  const lines = markdown.split(/\r?\n/);
  for (let index = 0; index + 1 < lines.length; index += 1) {
    const header = splitTableRow(lines[index] ?? "");
    const delimiter = splitTableRow(lines[index + 1] ?? "");
    if (!header || !delimiter || !isDelimiterRow(delimiter)) continue;
    if (header.length !== delimiter.length || header.length < 2) continue;

    const rows: ParsedGlossaryTable["rows"] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      const cells = splitTableRow(lines[rowIndex] ?? "");
      if (!cells) break;
      while (cells.length < header.length) cells.push("");
      rows.push({
        cellsMarkdown: cells,
        definitionMarkdown: cells[1] ?? "",
        rowOrder: rows.length,
        sourceLine: rowIndex + 1,
        termMarkdown: cells[0] ?? "",
      });
    }
    return { rows, startLine: index + 1 };
  }
  return null;
}
