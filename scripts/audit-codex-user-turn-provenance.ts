#!/usr/bin/env npx tsx

/**
 * Read-only audit of Codex response-item/user-turn provenance.
 *
 * Usage:
 *   pnpm codex:user-turns:audit
 *   pnpm codex:user-turns:audit -- ~/.codex/sessions/2026/07/10
 *   pnpm codex:user-turns:audit -- --session <session-id>
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { UrlProjectId } from "../packages/shared/src/projectId.js";
import type { CodexSessionEntry } from "../packages/shared/src/codex-schema/session.js";
import { parseCodexSessionEntry } from "../packages/shared/src/codex-schema/session.js";
import { normalizeSession } from "../packages/server/src/sessions/normalization.js";
import type { Message } from "../packages/server/src/supervisor/types.js";
import {
  buildCodexUserTurnProvenance,
  countCodexUserTurns,
  codexUserMessageEventText,
  findFirstCodexUserTurn,
  isCodexUserMessageEventEntry,
  isCodexUserResponseEntry,
} from "../packages/server/src/sessions/codex-user-turn-provenance.js";

interface AuditOptions {
  target: string;
  sessionId?: string;
}

interface AuditTotals {
  files: number;
  parsedEntries: number;
  malformedLines: number;
  compressedSkipped: number;
  userEvents: number;
  pairedUserEvents: number;
  userResponses: number;
  authoredResponses: number;
  hiddenContextResponses: number;
  visibleContextResponses: number;
  legacyUnknownResponses: number;
  normalizedUserTurns: number;
  normalizedProvenancedUserTurns: number;
}

interface SessionMeta {
  id?: string;
  cliVersion?: string;
  originator?: string;
}

interface UnpairedCategory {
  count: number;
  examples: Set<string>;
}

function parseArgs(args: string[]): AuditOptions {
  let target = join(homedir(), ".codex", "sessions");
  let sessionId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--session") {
      sessionId = args[index + 1];
      index += 1;
    } else if (arg?.startsWith("--session=")) {
      sessionId = arg.slice("--session=".length);
    } else if (arg && !arg.startsWith("--")) {
      target = resolve(arg.replace(/^~(?=\/)/u, homedir()));
    }
  }

  return { target, ...(sessionId ? { sessionId } : {}) };
}

function collectRollouts(target: string): {
  plain: string[];
  compressed: string[];
} {
  const plain: string[] = [];
  const compressed: string[] = [];

  const visit = (path: string) => {
    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      for (const entry of readdirSync(path)) {
        visit(join(path, entry));
      }
    } else if (path.endsWith(".jsonl.zst")) {
      compressed.push(path);
    } else if (path.endsWith(".jsonl")) {
      plain.push(path);
    }
  };

  visit(target);
  return { plain: plain.sort(), compressed: compressed.sort() };
}

function parseRollout(filePath: string): {
  entries: CodexSessionEntry[];
  malformedLines: number;
} {
  const entries: CodexSessionEntry[] = [];
  let malformedLines = 0;
  for (const line of readFileSync(filePath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = parseCodexSessionEntry(line);
    if (entry) {
      entries.push(entry);
    } else {
      malformedLines += 1;
    }
  }
  return { entries, malformedLines };
}

function getSessionMeta(entries: readonly CodexSessionEntry[]): SessionMeta {
  const meta = entries.find((entry) => entry.type === "session_meta");
  if (meta?.type !== "session_meta") return {};
  return {
    id: meta.payload.id,
    cliVersion: meta.payload.cli_version,
    originator: meta.payload.originator,
  };
}

function safeResponseCategory(entry: CodexSessionEntry): string {
  if (!isCodexUserResponseEntry(entry)) return "<not-user-response>";
  const blockTypes = entry.payload.content.map((block) => block.type).join(",");
  const firstText = entry.payload.content.find(
    (block) => "text" in block && typeof block.text === "string",
  );
  const trimmed =
    firstText && "text" in firstText ? firstText.text.trimStart() : "";
  let preview = "<unmarked>";
  if (trimmed.startsWith("# AGENTS.md instructions")) {
    preview = "# AGENTS.md instructions";
  } else if (trimmed.startsWith("Warning: apply_patch was requested via ")) {
    preview = "Warning: apply_patch via exec";
  } else {
    const tag = /^<[^ >]+/u.exec(trimmed)?.[0];
    if (tag) preview = `${tag}>`;
  }
  return `${blockTypes} | ${preview}`;
}

interface NormalizedUserTurn {
  provenance?: unknown;
  text: string;
}

function normalizedUserTurn(message: Message): NormalizedUserTurn | null {
  if (message.type !== "user" || message.message?.role !== "user") {
    return null;
  }
  const content = message.message.content;
  const provenance = message.codexUserTurnProvenance;
  if (typeof content === "string") {
    return { provenance, text: content.trim() };
  }
  if (!Array.isArray(content)) return { provenance, text: "" };
  if (content.some((block) => block.type === "tool_result")) return null;
  return {
    provenance,
    text: content
      .map((block) => (block.type === "text" ? (block.text ?? "") : ""))
      .join("")
      .trim(),
  };
}

function normalizeUserTurns(
  entries: CodexSessionEntry[],
  sessionId: string,
): NormalizedUserTurn[] {
  const normalized = normalizeSession({
    summary: {
      id: sessionId,
      projectId: "audit" as UrlProjectId,
      title: null,
      fullTitle: null,
      createdAt: "",
      updatedAt: "",
      messageCount: 0,
      ownership: { owner: "none" },
      provider: "codex",
    },
    data: { provider: "codex", session: { entries } },
  });
  return normalized.messages
    .map(normalizedUserTurn)
    .filter((turn): turn is NormalizedUserTurn => turn !== null);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  if (!existsSync(options.target)) {
    console.error(`Codex audit target does not exist: ${options.target}`);
    process.exitCode = 1;
    return;
  }

  const rollouts = collectRollouts(options.target);
  const totals: AuditTotals = {
    files: 0,
    parsedEntries: 0,
    malformedLines: 0,
    compressedSkipped: rollouts.compressed.length,
    userEvents: 0,
    pairedUserEvents: 0,
    userResponses: 0,
    authoredResponses: 0,
    hiddenContextResponses: 0,
    visibleContextResponses: 0,
    legacyUnknownResponses: 0,
    normalizedUserTurns: 0,
    normalizedProvenancedUserTurns: 0,
  };
  const unpairedCategories = new Map<string, UnpairedCategory>();
  const exceptions: string[] = [];
  let requestedSession:
    | {
        filePath: string;
        firstTurn: string | null;
        firstVisibleTurn: string | null;
        userTurns: number;
      }
    | undefined;

  for (const filePath of rollouts.plain) {
    const parsed = parseRollout(filePath);
    const entries = parsed.entries;
    const meta = getSessionMeta(entries);
    const provenance = buildCodexUserTurnProvenance(entries);
    const userEvents = entries.filter(isCodexUserMessageEventEntry);
    const userResponses = entries.filter(isCodexUserResponseEntry);
    const pairedEventCount = provenance.pairedUserEvents.size;
    const authoredCount = [...provenance.responseKinds.values()].filter(
      (kind) => kind === "user-authored",
    ).length;
    const classifiedUserTurns = countCodexUserTurns(entries, provenance);
    const normalizedUserTurns = normalizeUserTurns(
      entries,
      meta.id ?? basename(filePath),
    );

    totals.files += 1;
    totals.parsedEntries += entries.length;
    totals.malformedLines += parsed.malformedLines;
    totals.userEvents += userEvents.length;
    totals.pairedUserEvents += pairedEventCount;
    totals.userResponses += userResponses.length;
    totals.authoredResponses += authoredCount;
    totals.hiddenContextResponses += [
      ...provenance.responseKinds.values(),
    ].filter((kind) => kind === "hidden-provider-context").length;
    totals.visibleContextResponses += [
      ...provenance.responseKinds.values(),
    ].filter((kind) => kind === "visible-provider-context").length;
    totals.legacyUnknownResponses += [
      ...provenance.responseKinds.values(),
    ].filter((kind) => kind === "legacy-unknown").length;
    totals.normalizedUserTurns += normalizedUserTurns.length;
    const normalizedProvenancedUserTurns = normalizedUserTurns.filter(
      (turn) => typeof turn.provenance === "string",
    ).length;
    totals.normalizedProvenancedUserTurns += normalizedProvenancedUserTurns;

    for (const response of userResponses) {
      if (provenance.responseKinds.get(response) === "user-authored") continue;
      const category = [
        meta.cliVersion ?? "unknown-version",
        meta.originator ?? "unknown-originator",
        safeResponseCategory(response),
      ].join(" | ");
      const aggregate = unpairedCategories.get(category) ?? {
        count: 0,
        examples: new Set<string>(),
      };
      aggregate.count += 1;
      if (aggregate.examples.size < 2) {
        aggregate.examples.add(meta.id ?? basename(filePath));
      }
      unpairedCategories.set(category, aggregate);
    }

    if (authoredCount !== pairedEventCount) {
      exceptions.push(
        `${filePath}: ${authoredCount} authored responses != ${pairedEventCount} paired events`,
      );
    }
    if (
      provenance.hasUserMessageEvents &&
      pairedEventCount !== userEvents.length
    ) {
      exceptions.push(
        `${filePath}: ${userEvents.length - pairedEventCount} unpaired user events`,
      );
    }
    if (
      provenance.hasUserMessageEvents &&
      classifiedUserTurns !== userEvents.length
    ) {
      exceptions.push(
        `${filePath}: ${classifiedUserTurns} classified turns != ${userEvents.length} user events`,
      );
    }
    if (normalizedUserTurns.length !== classifiedUserTurns) {
      exceptions.push(
        `${filePath}: ${normalizedUserTurns.length} normalized user turns != ${classifiedUserTurns} classified turns`,
      );
    }
    if (normalizedProvenancedUserTurns !== normalizedUserTurns.length) {
      exceptions.push(
        `${filePath}: ${normalizedUserTurns.length - normalizedProvenancedUserTurns} normalized user turns lack provenance`,
      );
    }

    const firstEventText = userEvents[0]
      ? codexUserMessageEventText(userEvents[0])
      : undefined;
    const firstTurn = findFirstCodexUserTurn(entries, provenance);
    if (firstEventText && firstTurn?.text !== firstEventText) {
      exceptions.push(
        `${filePath}: first classified turn disagrees with first user event`,
      );
    }

    if (
      options.sessionId &&
      (meta.id === options.sessionId ||
        basename(filePath).includes(options.sessionId))
    ) {
      requestedSession = {
        filePath,
        firstTurn: firstTurn?.text ?? null,
        firstVisibleTurn: normalizedUserTurns[0]?.text ?? null,
        userTurns: classifiedUserTurns,
      };
    }
  }

  console.log("Codex user-turn provenance audit");
  console.log(`Target: ${options.target}`);
  console.log(`Plain rollouts: ${totals.files}`);
  console.log(`Compressed rollouts skipped: ${totals.compressedSkipped}`);
  console.log(`Parsed entries: ${totals.parsedEntries}`);
  console.log(`Malformed lines: ${totals.malformedLines}`);
  console.log(`User events: ${totals.userEvents}`);
  console.log(`Paired user events: ${totals.pairedUserEvents}`);
  console.log(`User response items: ${totals.userResponses}`);
  console.log(`Authored responses: ${totals.authoredResponses}`);
  console.log(`Hidden context responses: ${totals.hiddenContextResponses}`);
  console.log(`Visible context responses: ${totals.visibleContextResponses}`);
  console.log(`Legacy/unknown responses: ${totals.legacyUnknownResponses}`);
  console.log(`Normalized user turns: ${totals.normalizedUserTurns}`);
  console.log(
    `Normalized provenanced user turns: ${totals.normalizedProvenancedUserTurns}`,
  );

  console.log("Unpaired response categories:");
  for (const [category, aggregate] of [...unpairedCategories.entries()].sort(
    (left, right) =>
      right[1].count - left[1].count || left[0].localeCompare(right[0]),
  )) {
    console.log(
      `  ${aggregate.count} | ${category} | examples: ${[...aggregate.examples].join(", ")}`,
    );
  }

  if (options.sessionId) {
    if (requestedSession) {
      console.log(`Requested session: ${requestedSession.filePath}`);
      console.log(
        `Requested session user turns: ${requestedSession.userTurns}`,
      );
      console.log(
        `Requested session first turn: ${JSON.stringify(requestedSession.firstTurn)}`,
      );
      console.log(
        `Requested session first visible turn: ${JSON.stringify(requestedSession.firstVisibleTurn)}`,
      );
    } else {
      exceptions.push(`requested session not found: ${options.sessionId}`);
    }
  }

  console.log(`Exceptions: ${exceptions.length}`);
  for (const exception of exceptions) {
    console.error(`  ${exception}`);
  }

  if (exceptions.length > 0 || totals.malformedLines > 0) {
    process.exitCode = 1;
  }
}

main();
