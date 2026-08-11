import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Prepend before any git subcommand that emits paths (`status`, `diff`, `log`,
 * `ls-files`, `blame`, `diff-tree`) so non-ASCII paths are not octal-escaped.
 */
export const GIT_DECODE_PATHS_ARGS = ["-c", "core.quotePath=false"];

const DEFAULT_MAX_BUFFER = 1024 * 1024;
const GIT_EXEC_PREFIX = ["--no-optional-locks", "-C"];

/**
 * Run `git --no-optional-locks -C <cwd> <args>` and resolve its
 * `{ stdout, stderr }`. The shared git exec primitive disables opportunistic
 * index refreshes and maintenance so observation never briefly locks a
 * project against concurrent user or agent Git work. Explicit mutations still
 * take their required locks. No shell — args are passed as an array, so there
 * is no quoting/injection surface. stdout is NOT trimmed; callers trim as
 * needed.
 *
 * `maxBuffer` defaults to 1 MB (fine for status/diff); pass a larger value for
 * `log`/`blame`/`show` whose output can exceed it.
 */
export async function runGit(
  cwd: string,
  args: string[],
  options?: {
    timeout?: number;
    disableTerminalPrompt?: boolean;
    maxBuffer?: number;
  },
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync("git", [...GIT_EXEC_PREFIX, cwd, ...args], {
    maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    timeout: options?.timeout ?? 10_000,
    ...(options?.disableTerminalPrompt
      ? { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
      : {}),
  });
}

/**
 * Binary-safe counterpart to {@link runGit}. Use for blob content that must
 * be classified before any UTF-8 decoding replaces malformed bytes.
 */
export async function runGitBytes(
  cwd: string,
  args: string[],
  options?: {
    timeout?: number;
    disableTerminalPrompt?: boolean;
    maxBuffer?: number;
  },
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return (await execFileAsync("git", [...GIT_EXEC_PREFIX, cwd, ...args], {
    encoding: "buffer",
    maxBuffer: options?.maxBuffer ?? DEFAULT_MAX_BUFFER,
    timeout: options?.timeout ?? 10_000,
    ...(options?.disableTerminalPrompt
      ? { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } }
      : {}),
  })) as unknown as { stdout: Buffer; stderr: Buffer };
}
