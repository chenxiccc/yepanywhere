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

function codePointAt(text: string, index: number): string | undefined {
  const codePoint = text.codePointAt(index);
  return codePoint === undefined ? undefined : String.fromCodePoint(codePoint);
}

function codePointBefore(text: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const previous = text.charCodeAt(index - 1);
  const start =
    previous >= 0xdc00 &&
    previous <= 0xdfff &&
    index >= 2 &&
    text.charCodeAt(index - 2) >= 0xd800 &&
    text.charCodeAt(index - 2) <= 0xdbff
      ? index - 2
      : index - 1;
  return codePointAt(text, start);
}

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char);
}

function isPunctuation(char: string | undefined): boolean {
  return char !== undefined && /[\p{P}\p{S}]/u.test(char);
}

function delimiterCanOpen(
  text: string,
  index: number,
  delimiter: string,
): boolean {
  const previous = codePointBefore(text, index);
  const next = codePointAt(text, index + delimiter.length);
  const leftFlanking =
    !isWhitespace(next) &&
    (!isPunctuation(next) || isWhitespace(previous) || isPunctuation(previous));
  const rightFlanking =
    !isWhitespace(previous) &&
    (!isPunctuation(previous) || isWhitespace(next) || isPunctuation(next));
  return delimiter[0] === "_"
    ? leftFlanking && (!rightFlanking || isPunctuation(previous))
    : leftFlanking;
}

function delimiterCanClose(
  text: string,
  index: number,
  delimiter: string,
): boolean {
  const previous = codePointBefore(text, index);
  const next = codePointAt(text, index + delimiter.length);
  const leftFlanking =
    !isWhitespace(next) &&
    (!isPunctuation(next) || isWhitespace(previous) || isPunctuation(previous));
  const rightFlanking =
    !isWhitespace(previous) &&
    (!isPunctuation(previous) || isWhitespace(next) || isPunctuation(next));
  return delimiter[0] === "_"
    ? rightFlanking && (!leftFlanking || isPunctuation(next))
    : rightFlanking;
}

function findClosingMarkupDelimiter(
  text: string,
  start: number,
  end: number,
  delimiter: string,
): number {
  for (let index = start; index + delimiter.length <= end; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === "`") {
      const length = delimiterLengthAt(text, index, "`");
      const codeDelimiter = "`".repeat(length);
      const close = findClosingDelimiter(text, index + length, codeDelimiter);
      if (close >= 0 && close < end) {
        index = close + length - 1;
        continue;
      }
    }
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      if (close >= 0 && close < end) {
        index = close + 2;
        continue;
      }
    }
    if (
      text.startsWith(delimiter, index) &&
      delimiterCanClose(text, index, delimiter)
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * Flatten the small inline-Markdown subset used by glossary cells while
 * retaining whether visible text came from strong emphasis.
 */
function parseGlossaryInlineRange(
  markdown: string,
  start: number,
  end: number,
  required: boolean,
  pieces: VisiblePiece[],
): boolean {
  let hasBold = false;

  for (let index = start; index < end; ) {
    const char = markdown[index] ?? "";
    if (char === "\\" && index + 1 < end) {
      appendPiece(pieces, markdown[index + 1] ?? "", required);
      index += 2;
      continue;
    }

    if (char === "`") {
      const length = delimiterLengthAt(markdown, index, "`");
      const delimiter = "`".repeat(length);
      const close = findClosingDelimiter(markdown, index + length, delimiter);
      if (close >= 0 && close < end) {
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
        appendPiece(pieces, content, required);
        index = close + length;
        continue;
      }
    }

    const delimiter = markdown.startsWith("**", index)
      ? "**"
      : markdown.startsWith("__", index)
        ? "__"
        : markdown.startsWith("~~", index)
          ? "~~"
          : char === "*" || char === "_"
            ? char
            : null;
    if (delimiter) {
      const strong = delimiter === "**" || delimiter === "__";
      if (delimiterCanOpen(markdown, index, delimiter)) {
        const close = findClosingMarkupDelimiter(
          markdown,
          index + delimiter.length,
          end,
          delimiter,
        );
        if (close >= 0) {
          const nestedHasBold = parseGlossaryInlineRange(
            markdown,
            index + delimiter.length,
            close,
            required || strong,
            pieces,
          );
          hasBold ||= strong || nestedHasBold;
          index = close + delimiter.length;
          continue;
        }
      }
      appendPiece(pieces, delimiter, required);
      index += delimiter.length;
      continue;
    }

    if (markdown.startsWith("<!--", index)) {
      const close = markdown.indexOf("-->", index + 4);
      if (close >= 0 && close < end) {
        index = close + 3;
        continue;
      }
    }

    if (char === "<") {
      const close = markdown.indexOf(">", index + 1);
      if (close >= 0 && close < end) {
        const inside = markdown.slice(index + 1, close);
        if (/^\/?[A-Za-z][^>]*$/.test(inside)) {
          index = close + 1;
          continue;
        }
        if (/^(?:https?:\/\/|mailto:)/i.test(inside)) {
          appendPiece(pieces, inside, required);
          index = close + 1;
          continue;
        }
      }
    }

    if (char === "[" || (char === "!" && markdown[index + 1] === "[")) {
      const labelStart = char === "!" ? index + 2 : index + 1;
      const labelEnd = markdown.indexOf("]", labelStart);
      if (labelEnd >= 0 && labelEnd < end) {
        const nested = parseGlossaryInline(
          markdown.slice(labelStart, labelEnd),
        );
        hasBold ||= nested.hasBold;
        for (const piece of nested.pieces) {
          appendPiece(pieces, piece.text, required || piece.required);
        }
        let next = labelEnd + 1;
        if (markdown[next] === "(") {
          const destinationEnd = markdown.indexOf(")", next + 1);
          if (destinationEnd >= 0 && destinationEnd < end) {
            next = destinationEnd + 1;
          }
        } else if (markdown[next] === "[") {
          const referenceEnd = markdown.indexOf("]", next + 1);
          if (referenceEnd >= 0 && referenceEnd < end) {
            next = referenceEnd + 1;
          }
        }
        index = next;
        continue;
      }
    }

    if (char === "&") {
      const entity = /^&(?:#\d+|#x[\da-f]+|amp|lt|gt|quot|apos);/i.exec(
        markdown.slice(index, end),
      )?.[0];
      if (entity) {
        appendPiece(pieces, decodeEntity(entity), required);
        index += entity.length;
        continue;
      }
    }

    appendPiece(pieces, char, required);
    index += 1;
  }

  return hasBold;
}

export function parseGlossaryInline(markdown: string): {
  hasBold: boolean;
  pieces: VisiblePiece[];
} {
  const pieces: VisiblePiece[] = [];
  const hasBold = parseGlossaryInlineRange(
    markdown,
    0,
    markdown.length,
    false,
    pieces,
  );
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
    const markupDelimiter = markdown.startsWith("**", index)
      ? "**"
      : markdown.startsWith("__", index)
        ? "__"
        : markdown.startsWith("~~", index)
          ? "~~"
          : char === "*" || char === "_"
            ? char
            : null;
    if (markupDelimiter && delimiterCanOpen(markdown, index, markupDelimiter)) {
      const close = findClosingMarkupDelimiter(
        markdown,
        index + markupDelimiter.length,
        markdown.length,
        markupDelimiter,
      );
      if (close >= 0) {
        index = close + markupDelimiter.length - 1;
        continue;
      }
    }
    if (char === "[") bracketDepth += 1;
    else if (char === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    else if (char === "(") parenDepth += 1;
    else if (char === ")") parenDepth = Math.max(0, parenDepth - 1);
    else if (char === "," && bracketDepth === 0 && parenDepth === 0) {
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

interface MarkdownFence {
  char: "`" | "~";
  length: number;
}

function fenceRun(line: string): {
  char: "`" | "~";
  length: number;
  remainder: string;
} | null {
  const indent = /^ {0,3}/.exec(line)?.[0].length ?? 0;
  const char = line[indent];
  if (char !== "`" && char !== "~") return null;
  let length = 0;
  while (line[indent + length] === char) length += 1;
  return {
    char,
    length,
    remainder: line.slice(indent + length),
  };
}

function tableEligibleLines(lines: readonly string[]): boolean[] {
  const eligible: boolean[] = [];
  let fence: MarkdownFence | null = null;

  for (const line of lines) {
    if (fence) {
      const run = fenceRun(line);
      if (
        run?.char === fence.char &&
        run.length >= fence.length &&
        run.remainder.trim() === ""
      ) {
        fence = null;
      }
      eligible.push(false);
      continue;
    }

    if (/^(?: {4}|\t)/.test(line)) {
      eligible.push(false);
      continue;
    }

    const run = fenceRun(line);
    if (
      run &&
      run.length >= 3 &&
      (run.char === "~" || !run.remainder.includes("`"))
    ) {
      fence = { char: run.char, length: run.length };
      eligible.push(false);
      continue;
    }
    eligible.push(true);
  }
  return eligible;
}

/** Parse rows from the first Markdown table in a glossary document. */
export function parseFirstGlossaryTable(
  markdown: string,
): ParsedGlossaryTable | null {
  const lines = markdown.split(/\r?\n/);
  const eligible = tableEligibleLines(lines);
  for (let index = 0; index + 1 < lines.length; index += 1) {
    if (!eligible[index] || !eligible[index + 1]) continue;
    const header = splitTableRow(lines[index] ?? "");
    const delimiter = splitTableRow(lines[index + 1] ?? "");
    if (!header || !delimiter || !isDelimiterRow(delimiter)) continue;
    if (header.length !== delimiter.length || header.length < 2) continue;

    const rows: ParsedGlossaryTable["rows"] = [];
    for (let rowIndex = index + 2; rowIndex < lines.length; rowIndex += 1) {
      if (!eligible[rowIndex]) break;
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
