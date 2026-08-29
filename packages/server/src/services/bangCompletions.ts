/**
 * Completion candidates for `!!` bang-command drafts: executable names from
 * the server's PATH plus project-root executables for the command token, and
 * project-relative paths for argument tokens. Contract: topics/bang-commands.md.
 */

import { execFile } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const COMPLETION_LIMIT = 50;
const COMMAND_SCAN_TTL_MS = 30_000;

interface CommandScanCache {
  key: string;
  scannedAtMs: number;
  names: string[];
}

let commandScanCache: CommandScanCache | null = null;

async function listExecutableNames(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const names: string[] = [];
  await Promise.all(
    entries.map(async (name) => {
      try {
        const stat = await fsp.stat(path.join(dir, name));
        if (stat.isFile() && (stat.mode & 0o111) !== 0) {
          names.push(name);
        }
      } catch {
        // Broken symlink or unreadable entry.
      }
    }),
  );
  return names;
}

export async function listBangCommandCompletions(options: {
  prefix: string;
  projectPath: string;
  pathEnv?: string;
  limit?: number;
}): Promise<string[]> {
  const pathEnv = options.pathEnv ?? process.env.PATH ?? "";
  const limit = options.limit ?? COMPLETION_LIMIT;
  const cacheKey = `${pathEnv}\0${options.projectPath}`;
  let names: string[];
  if (
    commandScanCache?.key === cacheKey &&
    Date.now() - commandScanCache.scannedAtMs < COMMAND_SCAN_TTL_MS
  ) {
    names = commandScanCache.names;
  } else {
    const dirs = [
      ...pathEnv.split(path.delimiter).filter(Boolean),
      options.projectPath,
    ];
    const perDir = await Promise.all(dirs.map(listExecutableNames));
    names = [...new Set(perDir.flat())].sort();
    commandScanCache = { key: cacheKey, scannedAtMs: Date.now(), names };
  }
  return names
    .filter((name) => name.startsWith(options.prefix))
    .slice(0, limit);
}

export async function listBangPathCompletions(options: {
  tokenPrefix: string;
  projectPath: string;
  limit?: number;
}): Promise<string[]> {
  const limit = options.limit ?? COMPLETION_LIMIT;
  const token = options.tokenPrefix;
  const slashIndex = token.lastIndexOf("/");
  const dirPart = slashIndex >= 0 ? token.slice(0, slashIndex + 1) : "";
  const basePart = slashIndex >= 0 ? token.slice(slashIndex + 1) : token;
  const resolvedDir = path.resolve(options.projectPath, dirPart || ".");
  const projectRoot = path.resolve(options.projectPath);
  if (
    resolvedDir !== projectRoot &&
    !resolvedDir.startsWith(projectRoot + path.sep)
  ) {
    return [];
  }
  let entries: Dirent[];
  try {
    entries = await fsp.readdir(resolvedDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.name.startsWith(basePart) &&
        (basePart.startsWith(".") || !entry.name.startsWith(".")),
    )
    .map((entry) => `${dirPart}${entry.name}${entry.isDirectory() ? "/" : ""}`)
    .sort()
    .slice(0, limit);
}

const ACLI_COMPLETE_TIMEOUT_MS = 1500;
const ACLI_COMPLETE_MAX_OUTPUT = 256 * 1024;

/**
 * Commands trusted to implement the acli `--acli-complete` verb
 * (~/agents/topics/acli.md § Completion protocol). Tab must never
 * execute an arbitrary program — a lax non-compliant tool could ignore the
 * unknown flag and run its default action — so per-tool completion is
 * strictly allowlist-gated: YA_BANG_ACLI_COMPLETERS (comma-separated
 * basenames) plus this default set.
 */
const DEFAULT_ACLI_COMPLETERS = ["harness-check"];

function acliCompleterAllowlist(): Set<string> {
  const extra = (process.env.YA_BANG_ACLI_COMPLETERS ?? "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return new Set([...DEFAULT_ACLI_COMPLETERS, ...extra]);
}

/**
 * Ask an acli-compliant tool for argument completions by invoking it as
 * `tool --acli-complete <argv-prefix...>` in the project directory.
 * Returns null when the command is not allowlisted or the probe fails,
 * so callers fall back to path completion.
 */
export async function listAcliArgCompletions(options: {
  /** Bang draft body (text after `!!`), used to derive the current argv. */
  line: string;
  projectPath: string;
  limit?: number;
  timeoutMs?: number;
}): Promise<string[] | null> {
  const limit = options.limit ?? COMPLETION_LIMIT;
  const segments = options.line.split(/[|;&]/);
  const segment = segments[segments.length - 1] ?? "";
  const endsWithSpace = /\s$/.test(segment);
  const tokens = segment.trim().split(/\s+/).filter(Boolean);
  const command = tokens[0];
  if (!command || !acliCompleterAllowlist().has(path.basename(command))) {
    return null;
  }
  const argv = tokens.slice(1);
  if (endsWithSpace) {
    argv.push("");
  }
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.PATH = env.PATH
    ? `${env.PATH}${path.delimiter}${options.projectPath}`
    : options.projectPath;
  const stdout = await new Promise<string | null>((resolve) => {
    execFile(
      command,
      ["--acli-complete", ...argv],
      {
        cwd: options.projectPath,
        env,
        timeout: options.timeoutMs ?? ACLI_COMPLETE_TIMEOUT_MS,
        maxBuffer: ACLI_COMPLETE_MAX_OUTPUT,
      },
      (error, out) => {
        resolve(error ? null : out);
      },
    );
  });
  if (stdout === null) {
    return null;
  }
  const completions: string[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as { completion?: unknown };
      if (typeof parsed.completion === "string" && parsed.completion) {
        completions.push(parsed.completion);
      }
    } catch {
      // Ignore non-JSONL noise; the protocol is JSONL-only.
    }
    if (completions.length >= limit) {
      break;
    }
  }
  return completions;
}

const HISTORY_INDEX_MAX_PREFIX_CHARS = 24;
const HISTORY_INDEX_MIN_OCCUPANCY = 3;

/**
 * Prefix index over the global `!!` command-history corpus, so per-keystroke
 * completion requests don't rescan the whole corpus. Trie-like as a flat map:
 * every lowercased prefix (up to a length cap) shared by
 * `HISTORY_INDEX_MIN_OCCUPANCY`+ commands gets a bucket of corpus indices;
 * rarer or longer prefixes fall back to filtering the longest indexed
 * ancestor's bucket (or the full corpus when none exists), which is small by
 * construction on the rare-prefix side. Buckets hold ascending corpus indices,
 * so the caller's newest-first order is preserved.
 *
 * Match semantics (contract: topics/bang-commands.md § Tab completion, global
 * command history): case-insensitive prefix match against whole prior command
 * lines, commands assumed most-recent-first and deduped, the command exactly
 * equal to the current body excluded (completing to itself is a no-op),
 * capped at `limit`.
 */
export class BangHistoryIndex {
  private readonly commands: readonly string[];
  private readonly lowered: string[];
  private readonly buckets = new Map<string, number[]>();

  constructor(commands: readonly string[]) {
    this.commands = commands;
    this.lowered = commands.map((command) => command.toLowerCase());
    const occupancy = new Map<string, number>();
    for (const lowered of this.lowered) {
      const max = Math.min(lowered.length, HISTORY_INDEX_MAX_PREFIX_CHARS);
      for (let end = 1; end <= max; end += 1) {
        const prefix = lowered.slice(0, end);
        occupancy.set(prefix, (occupancy.get(prefix) ?? 0) + 1);
      }
    }
    for (const [index, lowered] of this.lowered.entries()) {
      const max = Math.min(lowered.length, HISTORY_INDEX_MAX_PREFIX_CHARS);
      for (let end = 1; end <= max; end += 1) {
        const prefix = lowered.slice(0, end);
        if ((occupancy.get(prefix) ?? 0) < HISTORY_INDEX_MIN_OCCUPANCY) {
          continue;
        }
        let bucket = this.buckets.get(prefix);
        if (!bucket) {
          bucket = [];
          this.buckets.set(prefix, bucket);
        }
        bucket.push(index);
      }
    }
  }

  match(bodyPrefix: string, limit = 20): string[] {
    const needle = bodyPrefix.toLowerCase();
    let candidates: readonly number[] | null = null;
    for (
      let end = Math.min(needle.length, HISTORY_INDEX_MAX_PREFIX_CHARS);
      end >= 1;
      end -= 1
    ) {
      const bucket = this.buckets.get(needle.slice(0, end));
      if (bucket) {
        candidates = bucket;
        break;
      }
    }
    const matches: string[] = [];
    const consider = (index: number) => {
      if (this.commands[index] === bodyPrefix) {
        return false;
      }
      if (!this.lowered[index]?.startsWith(needle)) {
        return false;
      }
      matches.push(this.commands[index] as string);
      return matches.length >= limit;
    };
    if (candidates) {
      for (const index of candidates) {
        if (consider(index)) break;
      }
    } else {
      for (let index = 0; index < this.commands.length; index += 1) {
        if (consider(index)) break;
      }
    }
    return matches;
  }
}

/**
 * One-shot form of {@link BangHistoryIndex} matching, for callers without a
 * cached index.
 */
export function matchBangHistory(
  commands: readonly string[],
  bodyPrefix: string,
  limit = 20,
): string[] {
  return new BangHistoryIndex(commands).match(bodyPrefix, limit);
}

/** Test hook: drop the PATH scan cache. */
export function resetBangCompletionCache(): void {
  commandScanCache = null;
}
