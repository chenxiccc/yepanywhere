import { resolve } from "node:path";
import type { ProjectPathIndex } from "../projects/projectPathIndex.js";
import { renderLocalFileLink } from "./safe-markdown.js";

/**
 * Turn bare project-relative paths inside highlighted file content into the
 * same local-file links the Markdown viewer produces.
 *
 * Membership in the project's path set is the entire test — a string links
 * because it *is* a file here, not because it looks like one. That is what
 * makes this safe to run over arbitrary content: a JSON value like
 * `"runs/eval-v2.jsonl"` links, and prose about `application/json` or a
 * version like `1.2.3` cannot, without either needing a rule of its own.
 */

/**
 * Characters a path token may contain. Deliberately excludes quotes, brackets,
 * commas and colons so a JSON string, a YAML value, or a bare word in prose
 * yields the path and nothing around it. `&` is excluded because the
 * surrounding HTML is escaped and a decoded entity would not round-trip.
 */
const PATH_TOKEN = /[^\s"'`<>&,:;()[\]{}=|]+/g;

/** Trailing punctuation a writer adds that is not part of the path. */
const TRAILING_NOISE = /[.!?]+$/;

/**
 * Rewrite the text between tags, leaving markup untouched.
 *
 * Highlighted HTML nests spans per token, so a match is only looked for inside
 * one text run: a path split across two spans stays unlinked rather than
 * risking a rewrite that crosses a tag boundary.
 */
function mapHtmlTextRuns(
  html: string,
  mapText: (text: string) => string,
): string {
  let out = "";
  let index = 0;
  while (index < html.length) {
    const tagStart = html.indexOf("<", index);
    if (tagStart < 0) {
      out += mapText(html.slice(index));
      break;
    }
    out += mapText(html.slice(index, tagStart));
    const tagEnd = html.indexOf(">", tagStart);
    if (tagEnd < 0) {
      out += html.slice(tagStart);
      break;
    }
    out += html.slice(tagStart, tagEnd + 1);
    index = tagEnd + 1;
  }
  return out;
}

export interface ProjectPathLinkOptions {
  /** Absolute path of the project the content belongs to. */
  projectPath: string;
  index: ProjectPathIndex;
  /** Path of the file being viewed, so it does not link to itself. */
  selfRelativePath?: string;
}

/**
 * Link every project-relative path occurring in already-highlighted HTML.
 * Returns the input unchanged when the project has no indexed paths, so an
 * unavailable index degrades to today's plain content rather than an error.
 */
export function linkifyProjectPaths(
  html: string,
  { projectPath, index, selfRelativePath }: ProjectPathLinkOptions,
): string {
  if (!html || index.size === 0) return html;

  return mapHtmlTextRuns(html, (text) => {
    if (!text) return text;
    PATH_TOKEN.lastIndex = 0;
    let out = "";
    let cursor = 0;
    let match: RegExpExecArray | null = PATH_TOKEN.exec(text);
    while (match !== null) {
      const token = match[0];
      const trimmed = token.replace(TRAILING_NOISE, "");
      if (
        trimmed &&
        trimmed !== selfRelativePath &&
        index.has(trimmed)
      ) {
        const start = match.index;
        out += text.slice(cursor, start);
        out += renderLocalFileLink(
          { filePath: resolve(projectPath, trimmed) },
          trimmed,
          { title: trimmed },
        );
        out += token.slice(trimmed.length);
        cursor = start + token.length;
      }
      match = PATH_TOKEN.exec(text);
    }
    return cursor === 0 ? text : out + text.slice(cursor);
  });
}
