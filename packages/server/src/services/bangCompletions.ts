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
 * (~/agents topics/agent-cli.md § Completion protocol). Tab must never
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

/**
 * Prefix-match prior whole `!!` command lines against the current bang body
 * for the global command-history completion axis (ranked ahead of token
 * candidates). Case-insensitive prefix match; input order is preserved (the
 * caller passes commands most-recent-first, already deduped); the command
 * exactly equal to the current body is excluded (completing to itself is a
 * no-op); capped at `limit`. Contract: topics/bang-commands.md § Tab
 * completion (global command history).
 */
export function matchBangHistory(
  commands: readonly string[],
  bodyPrefix: string,
  limit = 20,
): string[] {
  const needle = bodyPrefix.toLowerCase();
  const matches: string[] = [];
  for (const command of commands) {
    if (command === bodyPrefix) {
      continue;
    }
    if (command.toLowerCase().startsWith(needle)) {
      matches.push(command);
      if (matches.length >= limit) {
        break;
      }
    }
  }
  return matches;
}

/** Test hook: drop the PATH scan cache. */
export function resetBangCompletionCache(): void {
  commandScanCache = null;
}
