/**
 * Tolerant reader for the TOON flat-table subset sanctioned by the acli spec
 * (~/agents topics/agent-cli.md): a `name[N]{c1,c2,...}:` header followed by
 * N comma-delimited, optionally double-quoted rows (optionally indented).
 * Read-side only — YA renders TOON it encounters; it never emits TOON.
 */

const TOON_HEADER_PATTERN = /^([\w.-]+)\[(\d+)\]\{([^}]*)\}:\s*$/;

export interface ToonTable {
  name: string;
  columns: string[];
  rows: string[][];
}

/** Cheap gate: does the first non-blank line look like a TOON table header? */
export function looksLikeToon(text: string): boolean {
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    return TOON_HEADER_PATTERN.test(line.trim());
  }
  return false;
}

function splitToonRow(line: string): string[] | null {
  const values: string[] = [];
  let current = "";
  let inQuotes = false;
  let closedQuotedCell = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (inQuotes) {
      if (char === '"') {
        if (line[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          inQuotes = false;
          closedQuotedCell = true;
        }
      } else {
        current += char;
      }
    } else if (closedQuotedCell) {
      if (char !== ",") {
        return null;
      }
      values.push(current);
      current = "";
      closedQuotedCell = false;
    } else if (char === '"' && current === "") {
      inQuotes = true;
    } else if (char === '"') {
      return null;
    } else if (char === ",") {
      values.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (inQuotes) {
    return null;
  }
  values.push(current);
  return values;
}

/**
 * Parse a document consisting solely of one or more TOON flat tables
 * (blank lines between tables allowed). Returns null unless the whole
 * document parses, so heuristic callers can fall back safely.
 */
export function parseToonDocument(text: string): ToonTable[] | null {
  const lines = text.trim().split("\n");
  const tables: ToonTable[] = [];
  let index = 0;
  while (index < lines.length) {
    if (!lines[index]?.trim()) {
      index += 1;
      continue;
    }
    const header = lines[index]?.trim().match(TOON_HEADER_PATTERN);
    if (!header) {
      return null;
    }
    const rowCount = Number(header[2]);
    const columns = (header[3] ?? "").split(",").map((name) => name.trim());
    if (columns.length === 0 || columns.some((name) => !name)) {
      return null;
    }
    index += 1;
    const rows: string[][] = [];
    for (let row = 0; row < rowCount; row += 1, index += 1) {
      const line = lines[index];
      if (line === undefined || !line.trim()) {
        return null;
      }
      const values = splitToonRow(line.trim());
      if (!values || values.length !== columns.length) {
        return null;
      }
      rows.push(values);
    }
    tables.push({ name: header[1] ?? "", columns, rows });
  }
  return tables.length > 0 ? tables : null;
}

/** Markdown-table form, for renderers that already have a markdown path. */
export function toonDocumentToMarkdown(tables: ToonTable[]): string {
  const escapeCell = (value: string) =>
    value.replace(/\|/g, "\\|").replace(/\n/g, " ");
  return tables
    .map((table) => {
      // A named table (every TOON header carries a name) gets a caption;
      // a nameless table (e.g. one synthesized from JSONL) omits it rather
      // than rendering an empty `**** (n)`.
      const caption = table.name
        ? [`**${escapeCell(table.name)}** (${table.rows.length})`, ""]
        : [];
      return [
        ...caption,
        `| ${table.columns.map(escapeCell).join(" | ")} |`,
        `| ${table.columns.map(() => "---").join(" | ")} |`,
        ...table.rows.map((row) => `| ${row.map(escapeCell).join(" | ")} |`),
      ].join("\n");
    })
    .join("\n\n");
}
