import type * as fs from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import type {
  GitFileChange,
  GitWorkingTreeChange,
  GitWorkingTreeFile,
  GitWorkingTreePathKind,
  GitWorktreeCoverage,
  GitWorktreeDirectory,
} from "@yep-anywhere/shared";
import { readGitDiffFileChanges } from "../git/fileChanges.js";
import { GIT_DECODE_PATHS_ARGS, runGit } from "../git/gitExec.js";
import { getLogger } from "../logging/logger.js";
import { getGitStatus } from "../routes/git-status.js";
import { compareWorktreePaths } from "./projectWorktreeCoverage.js";

const MAX_BUFFER = 64 * 1024 * 1024;

export interface ProjectWorktreeScan {
  headSha: string | null;
  baseSha: string | null;
  files: Map<string, GitWorkingTreeFile>;
  truncated?: boolean;
  /** Exact total files in this scan mode; absent when any count is unknown. */
  totalFiles?: number;
  /**
   * Content directories the scan actually enumerated. Present only for a
   * filesystem-only inventory; unopened descendants are neither read nor
   * watched.
   */
  directories?: Set<string>;
  /**
   * Lazy filesystem directory rows. Presence distinguishes expanded-prefix
   * inventory from the compatibility breadth-first scan.
   */
  directoryRows?: Map<string, GitWorktreeDirectory>;
}

export async function scanFilesystemWorktree(
  projectPath: string,
  coverage: GitWorktreeCoverage,
  fileLimit: number,
): Promise<ProjectWorktreeScan> {
  if (coverage.expandedPrefixes !== undefined) {
    return scanExpandedFilesystemWorktree(projectPath, coverage, fileLimit);
  }
  return scanFilesystemWorktreeBreadthFirst(projectPath, coverage, fileLimit);
}

async function scanExpandedFilesystemWorktree(
  projectPath: string,
  coverage: GitWorktreeCoverage,
  _fileLimit: number,
): Promise<ProjectWorktreeScan> {
  const files = new Map<string, GitWorkingTreeFile>();
  const directories = new Set<string>([""]);
  const directoryRows = new Map<string, GitWorktreeDirectory>([
    ["", { path: "", pending: false, truncated: false }],
  ]);
  if (!coverage.untracked) {
    return {
      headSha: null,
      baseSha: null,
      files,
      totalFiles: 0,
      directories,
      directoryRows,
    };
  }

  const expandedPrefixes = coverage.expandedPrefixes ?? [];
  const expanded = new Set(expandedPrefixes);
  let truncated = false;
  let totalFiles = 0;
  let totalFilesKnown = true;
  for (const prefix of ["", ...expandedPrefixes]) {
    // A requested prefix must first have been observed as a real directory in
    // its opened parent. Besides preserving one-level disclosure, this keeps a
    // guessed symlink path from escaping the project through readdir.
    if (prefix && !directoryRows.has(prefix)) continue;
    const absolute = prefix ? join(projectPath, prefix) : projectPath;
    let entries: fs.Dirent[];
    try {
      entries = await readdir(absolute, { withFileTypes: true });
    } catch (error) {
      if (isMissingPathError(error)) {
        if (prefix) directoryRows.delete(prefix);
        continue;
      }
      truncated = true;
      const fallbackTotalFiles = await countDirectFilesystemFiles(absolute);
      if (fallbackTotalFiles === null) {
        totalFilesKnown = false;
      } else {
        totalFiles += fallbackTotalFiles;
      }
      directoryRows.set(prefix, {
        path: prefix,
        pending: false,
        truncated: true,
        ...(fallbackTotalFiles === null
          ? {}
          : { totalFiles: fallbackTotalFiles }),
      });
      getLogger().debug(
        { directory: absolute, error, projectPath },
        "WORKTREE_SCAN: opened directory unreadable; listing reported incomplete",
      );
      continue;
    }

    directories.add(prefix);
    entries.sort((left, right) => compareWorktreePaths(left.name, right.name));
    let directFiles = 0;
    for (const entry of entries) {
      if (entry.name === ".git") continue;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        const opened = expanded.has(path);
        const previous = directoryRows.get(path);
        directoryRows.set(path, {
          path,
          pending: !opened,
          truncated: opened && previous?.truncated === true,
        });
        continue;
      }
      files.set(path, createFilesystemFile(path));
      directFiles += 1;
      totalFiles += 1;
    }
    directoryRows.set(prefix, {
      path: prefix,
      pending: false,
      truncated: false,
      totalFiles: directFiles,
    });
  }

  return {
    headSha: null,
    baseSha: null,
    files,
    truncated,
    ...(totalFilesKnown ? { totalFiles } : {}),
    directories,
    directoryRows,
  };
}

async function scanFilesystemWorktreeBreadthFirst(
  projectPath: string,
  coverage: GitWorktreeCoverage,
  fileLimit: number,
): Promise<ProjectWorktreeScan> {
  if (!coverage.untracked) {
    return { headSha: null, baseSha: null, files: new Map() };
  }

  const files = new Map<string, GitWorkingTreeFile>();
  const directories = new Set<string>([""]);
  let level = [{ absolute: projectPath, relative: "" }];
  let truncated = false;
  // Compatibility path for clients predating expanded prefixes. Breadth-first
  // spending keeps a heavy subtree from hiding shallower files.
  while (level.length > 0) {
    const next: Array<{ absolute: string; relative: string }> = [];
    for (const current of level) {
      if (files.size >= fileLimit) {
        truncated = true;
        break;
      }
      let entries: fs.Dirent[];
      try {
        entries = await readdir(current.absolute, { withFileTypes: true });
      } catch (error) {
        if (!isMissingPathError(error)) {
          truncated = true;
          getLogger().debug(
            { directory: current.absolute, error, projectPath },
            "WORKTREE_SCAN: directory unreadable; inventory reported incomplete",
          );
        }
        continue;
      }
      directories.add(current.relative);
      entries.sort((left, right) =>
        compareWorktreePaths(left.name, right.name),
      );
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const path = current.relative
          ? `${current.relative}/${entry.name}`
          : entry.name;
        if (entry.isDirectory()) {
          next.push({
            absolute: join(current.absolute, entry.name),
            relative: path,
          });
          continue;
        }
        if (files.size >= fileLimit) {
          truncated = true;
          break;
        }
        files.set(path, createFilesystemFile(path));
      }
    }
    if (truncated) {
      if (next.length > 0) break;
      level = [];
      continue;
    }
    level = next;
  }
  return {
    headSha: null,
    baseSha: null,
    files,
    truncated,
    ...(!truncated ? { totalFiles: files.size } : {}),
    directories,
  };
}

async function countDirectFilesystemFiles(
  directory: string,
): Promise<number | null> {
  try {
    const names = (await readdir(directory)).filter((name) => name !== ".git");
    let count = 0;
    const batchSize = 64;
    for (let offset = 0; offset < names.length; offset += batchSize) {
      const stats = await Promise.all(
        names.slice(offset, offset + batchSize).map(async (name) => {
          try {
            return await lstat(join(directory, name));
          } catch (error) {
            if (isMissingPathError(error)) return null;
            throw error;
          }
        }),
      );
      for (const entry of stats) {
        if (entry && !entry.isDirectory()) count += 1;
      }
    }
    return count;
  } catch {
    return null;
  }
}

function createFilesystemFile(path: string): GitWorkingTreeFile {
  const change: GitWorkingTreeChange = {
    status: "?",
    staged: false,
    linesAdded: null,
    linesDeleted: null,
  };
  return {
    path,
    tracked: false,
    kind: "untracked",
    present: true,
    worktreeChanges: [change],
    cumulativeChange: change,
  };
}

export async function scanGitWorktree(
  projectPath: string,
  coverage: GitWorktreeCoverage,
): Promise<ProjectWorktreeScan> {
  const [headSha, cached, deleted, untracked, ignored] = await Promise.all([
    resolveCommit(projectPath, "HEAD"),
    coverage.tracked ? listGitPaths(projectPath, ["--cached"]) : [],
    coverage.tracked ? listGitPaths(projectPath, ["--deleted"]) : [],
    coverage.untracked
      ? listGitPaths(projectPath, ["--others", "--exclude-standard"])
      : [],
    coverage.ignored
      ? listGitPaths(projectPath, [
          "--others",
          "--ignored",
          "--exclude-standard",
        ])
      : [],
  ]);
  const baseSha = headSha ? await resolveCommit(projectPath, "HEAD^1") : null;
  const [status, cumulativeFiles] = await Promise.all([
    headSha ? getGitStatus(projectPath, null, false) : null,
    baseSha
      ? readGitDiffFileChanges(projectPath, [baseSha], {
          maxBuffer: MAX_BUFFER,
        })
      : [],
  ]);

  const worktreeByPath = groupChanges(status?.files ?? []);
  const cumulativeByPath = new Map(
    cumulativeFiles.map((change) => [change.path, withoutPath(change)]),
  );
  const deletedPaths = new Set(deleted);
  const files = new Map<string, GitWorkingTreeFile>();

  for (const path of cached) {
    if (!path || deletedPaths.has(path) || !validPath(projectPath, path))
      continue;
    files.set(
      path,
      createFile(path, "tracked", true, worktreeByPath, cumulativeByPath),
    );
  }
  for (const path of deletedPaths) {
    if (!path || !validPath(projectPath, path)) continue;
    const worktreeChanges = worktreeByPath.get(path);
    const cumulativeChange = cumulativeByPath.get(path);
    if (!worktreeChanges && !cumulativeChange) continue;
    files.set(path, {
      path,
      tracked: true,
      kind: "tracked",
      present: false,
      ...(worktreeChanges ? { worktreeChanges } : {}),
      ...(cumulativeChange ? { cumulativeChange } : {}),
    });
  }
  for (const path of untracked) {
    if (!path || files.has(path) || !validPath(projectPath, path)) continue;
    const untrackedChange: GitWorkingTreeChange = {
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    };
    files.set(path, {
      path,
      tracked: false,
      kind: "untracked",
      present: true,
      worktreeChanges: [untrackedChange],
      cumulativeChange: untrackedChange,
    });
  }
  for (const path of ignored) {
    if (!path || files.has(path) || !validPath(projectPath, path)) continue;
    files.set(path, {
      path,
      tracked: false,
      kind: "ignored",
      present: true,
    });
  }
  for (const [path, worktreeChanges] of worktreeByPath) {
    if (files.has(path) || !validPath(projectPath, path)) continue;
    files.set(path, {
      path,
      tracked: true,
      kind: "tracked",
      present: false,
      worktreeChanges,
      ...(cumulativeByPath.has(path)
        ? { cumulativeChange: cumulativeByPath.get(path) }
        : {}),
    });
  }

  return { headSha, baseSha, files };
}

function createFile(
  path: string,
  kind: GitWorkingTreePathKind,
  present: boolean,
  worktreeByPath: ReadonlyMap<string, GitWorkingTreeChange[]>,
  cumulativeByPath: ReadonlyMap<string, GitWorkingTreeChange>,
): GitWorkingTreeFile {
  const worktreeChanges = worktreeByPath.get(path);
  const cumulativeChange = cumulativeByPath.get(path);
  return {
    path,
    tracked: kind === "tracked",
    kind,
    present,
    ...(worktreeChanges ? { worktreeChanges } : {}),
    ...(cumulativeChange ? { cumulativeChange } : {}),
  };
}

function groupChanges(
  changes: readonly GitFileChange[],
): Map<string, GitWorkingTreeChange[]> {
  const result = new Map<string, GitWorkingTreeChange[]>();
  for (const change of changes) {
    const existing = result.get(change.path);
    const value = withoutPath(change);
    if (existing) existing.push(value);
    else result.set(change.path, [value]);
  }
  return result;
}

function withoutPath(change: GitFileChange): GitWorkingTreeChange {
  const { path: _path, ...value } = change;
  return value;
}

function validPath(projectPath: string, path: string): boolean {
  if (path.split("/").includes(".git")) return false;
  return isContained(projectPath, join(projectPath, path));
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return (
    rel === "" ||
    (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
  );
}

async function listGitPaths(
  projectPath: string,
  flags: string[],
): Promise<string[]> {
  const { stdout } = await runGit(
    projectPath,
    [...GIT_DECODE_PATHS_ARGS, "ls-files", "-z", ...flags],
    { maxBuffer: MAX_BUFFER },
  );
  const paths = stdout.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths;
}

async function resolveCommit(
  projectPath: string,
  revision: string,
): Promise<string | null> {
  try {
    const { stdout } = await runGit(projectPath, [
      "rev-parse",
      "--verify",
      `${revision}^{commit}`,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}
