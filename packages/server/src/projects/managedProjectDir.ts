/**
 * YA-managed project subdirectories.
 *
 * YA keeps some state inside a user's project tree — `.yep/` (source-review
 * drafts, interactives registry) and `.attachments/` (uploaded files). By
 * convention YA git-excludes such a dir the first time it creates one, so
 * YA-managed state doesn't clutter the project's `git status`, without
 * touching a committed `.gitignore`.
 *
 * The exclude is a one-time default applied *at creation only*: if the dir
 * already exists — because YA excluded it on an earlier visit, or because the
 * user deliberately un-excluded it to commit it — this leaves the git state
 * exactly as it found it. So this ensures the *directory* exists; it does not
 * ensure the dir stays excluded (hence the name, not "…Excluded").
 */

import { execFile } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Ensure a YA-managed project subdir exists, returning its path. `name` is the
 * top-level managed dir (e.g. `.yep` or `.attachments`); `subPath` are deeper
 * segments to also create under it. If YA is the one creating the top-level
 * dir, it is added to this clone's local git exclude by default (see the
 * module doc). Best-effort on the git side — a non-git tree or any git failure
 * never blocks directory creation.
 */
export async function ensureManagedProjectDir(
  projectPath: string,
  name: string,
  ...subPath: string[]
): Promise<string> {
  const top = join(projectPath, name);
  // mkdir(recursive) resolves to the first path created, or undefined if the
  // dir already existed — our exact "did YA just create this?" signal.
  const created = await mkdir(top, { recursive: true });
  if (created !== undefined) {
    await defaultGitExclude(projectPath, name);
  }

  if (subPath.length === 0) return top;
  const full = join(top, ...subPath);
  await mkdir(full, { recursive: true });
  return full;
}

/**
 * Append `${name}/` to this clone's `.git/info/exclude`. Resolved via
 * `git rev-parse --git-path` so it is correct inside linked worktrees. The
 * duplicate-line guard only matters if the dir was excluded, deleted, and
 * later recreated. Best-effort: all failures are swallowed.
 */
async function defaultGitExclude(
  projectPath: string,
  name: string,
): Promise<void> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", projectPath, "rev-parse", "--git-path", "info/exclude"],
      { timeout: 5000 },
    );
    const rel = stdout.trim();
    if (!rel) return;
    const excludePath = resolve(projectPath, rel);

    let current = "";
    try {
      current = await readFile(excludePath, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const pattern = `${name}/`;
    const already = current
      .split("\n")
      .map((line) => line.trim())
      .some((line) => line === pattern || line === name);
    if (already) return;

    await mkdir(dirname(excludePath), { recursive: true });
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    await appendFile(
      excludePath,
      `${prefix}# YA-managed local state (not committed)\n${pattern}\n`,
    );
  } catch {
    // Best-effort only.
  }
}
