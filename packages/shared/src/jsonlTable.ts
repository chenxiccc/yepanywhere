/**
 * Render consecutive runs of same-shape JSONL objects as GFM tables.
 *
 * The acli spec (~/agents topics/agent-cli.md) mandates compact JSONL for
 * non-TTY callers, so tools like `almanac` emit one flat object per line.
 * A run of >= `minRows` consecutive lines that each parse as a JSON object
 * with an identical key set is a uniform table; we render it via the shared
 * TOON markdown-table path (`toonDocumentToMarkdown`) and leave every other
 * line verbatim. Multiple runs (optionally interleaved with prose) each
 * become their own table.
 */

import { type ToonTable, toonDocumentToMarkdown } from "./toon.js";

type JsonObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Order-insensitive identity of an object's key set. JSON-encoding the
 * sorted keys is unambiguous even when a key name contains a delimiter. */
function keySignature(object: JsonObject): string {
  return JSON.stringify(Object.keys(object).sort());
}

/** One markdown-table cell: scalars as-is, null/undefined empty, nested compact JSON. */
function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

export interface JsonlTablesResult {
  markdown: string;
  tableCount: number;
}

export function jsonlTablesToMarkdown(
  text: string,
  minRows = 2,
): JsonlTablesResult {
  const lines = text.split("\n");
  const parts: string[] = [];
  let tableCount = 0;
  let index = 0;

  while (index < lines.length) {
    const run: JsonObject[] = [];
    let signature: string | null = null;
    let end = index;
    for (; end < lines.length; end += 1) {
      const line = lines[end];
      if (line === undefined || !line.trim()) {
        break;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        break;
      }
      if (!isPlainObject(parsed)) {
        break;
      }
      const signatureHere = keySignature(parsed);
      if (signature === null) {
        signature = signatureHere;
      } else if (signatureHere !== signature) {
        break;
      }
      run.push(parsed);
    }

    if (run.length >= minRows) {
      const columns = Object.keys(run[0] ?? {});
      const table: ToonTable = {
        name: "",
        columns,
        rows: run.map((object) =>
          columns.map((column) => cellText(object[column])),
        ),
      };
      if (parts.length > 0 && parts[parts.length - 1] !== "") {
        parts.push("");
      }
      parts.push(toonDocumentToMarkdown([table]));
      parts.push("");
      tableCount += 1;
      index = end;
    } else {
      parts.push(lines[index] ?? "");
      index += 1;
    }
  }

  const markdown = parts
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { markdown, tableCount };
}
