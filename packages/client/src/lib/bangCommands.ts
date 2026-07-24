/**
 * Composer routing and completion helpers for `!!` bang commands — local
 * shell commands run by YA in the project directory, never sent to the
 * provider. Contract: topics/bang-commands.md.
 */

import type {
  BangCommandTranscriptDisplayObject,
  TranscriptDisplayObject,
} from "@yep-anywhere/shared";

export type ComposerBangDraft =
  | { kind: "bang"; command: string }
  | { kind: "empty" }
  | { kind: "escaped"; text: string }
  | { kind: "none" };

/**
 * `!!command` routes to bang execution; a single leading space escapes the
 * prefix (the space is stripped and the rest goes to the provider verbatim).
 */
export function resolveComposerBangDraft(text: string): ComposerBangDraft {
  if (text.startsWith("!!")) {
    const command = text.slice(2).trim();
    return command ? { kind: "bang", command } : { kind: "empty" };
  }
  if (text.startsWith(" !!")) {
    return { kind: "escaped", text: text.slice(1) };
  }
  return { kind: "none" };
}

export interface BangCompletionQuery {
  token: string;
  kind: "command" | "path";
  /** Index in the draft where the completed token starts. */
  replaceStart: number;
}

/**
 * Completion query for the current bang draft. The trailing token completes
 * as a command name when it sits in command position — at the start, or
 * first word after an (unquoted) `|`, `;`, or `&` separator — else as a
 * project-relative path argument (flag-like tokens are not completed).
 */
export function getBangCompletionQuery(
  text: string,
): BangCompletionQuery | null {
  if (!text.startsWith("!!") || text.includes("\n")) {
    return null;
  }
  const body = text.slice(2);
  const token = body.match(/(\S*)$/)?.[1] ?? "";
  const beforeToken = body.slice(0, body.length - token.length);
  const separatorIndex = Math.max(
    beforeToken.lastIndexOf("|"),
    beforeToken.lastIndexOf(";"),
    beforeToken.lastIndexOf("&"),
  );
  const commandPosition = /^\s*$/.test(beforeToken.slice(separatorIndex + 1));
  if (commandPosition) {
    return { token, kind: "command", replaceStart: text.length - token.length };
  }
  if (!token || token.startsWith("-")) {
    return null;
  }
  return { token, kind: "path", replaceStart: text.length - token.length };
}

/** Shell-style longest common prefix over completion candidates. */
export function longestCommonPrefix(candidates: readonly string[]): string {
  if (candidates.length === 0) {
    return "";
  }
  let prefix = candidates[0] ?? "";
  for (const candidate of candidates.slice(1)) {
    while (prefix && !candidate.startsWith(prefix)) {
      prefix = prefix.slice(0, -1);
    }
  }
  return prefix;
}

export function applyBangCompletion(
  text: string,
  query: BangCompletionQuery,
  completion: string,
): string {
  const suffix = completion.endsWith("/") ? "" : " ";
  return text.slice(0, query.replaceStart) + completion + suffix;
}

/** Session bang-command history, newest first, deduplicated. */
export function collectBangHistory(
  objects: readonly TranscriptDisplayObject[] | undefined,
): string[] {
  if (!objects) {
    return [];
  }
  const commands = objects
    .filter(
      (object): object is BangCommandTranscriptDisplayObject =>
        object.kind === "bang-command",
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((object) => object.command);
  return [...new Set(commands)];
}

/** Provenance-labeled user-turn text for echoing a run into the session. */
export function buildBangEchoText(
  object: BangCommandTranscriptDisplayObject,
  output: { stdout: string; stderr: string },
  maxChars = 16_384,
): string {
  const clip = (text: string) =>
    text.length > maxChars
      ? `${text.slice(0, maxChars)}\n[... truncated ...]`
      : text;
  const fenced = (text: string) => {
    const longestBacktickRun = Math.max(
      0,
      ...Array.from(text.matchAll(/`+/g), (match) => match[0].length),
    );
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    return `${fence}\n${text}\n${fence}`;
  };
  const parts = [
    "I ran this local command myself (outside this conversation):",
    fenced(`$ ${object.command}`),
  ];
  if (output.stdout.trim()) {
    parts.push("Output:", fenced(clip(output.stdout.trimEnd())));
  }
  if (output.stderr.trim()) {
    parts.push("Stderr:", fenced(clip(output.stderr.trimEnd())));
  }
  parts.push(
    `Exit code ${object.exitCode ?? "unknown"}${
      object.durationMs != null
        ? ` after ${Math.round(object.durationMs / 1000)}s`
        : ""
    }.`,
  );
  return parts.join("\n");
}
