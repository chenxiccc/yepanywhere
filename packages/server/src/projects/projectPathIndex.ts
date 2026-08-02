import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { GIT_DECODE_PATHS_ARGS, runGit } from "../git/gitExec.js";

/**
 * Project-relative paths that exist right now, for turning a bare path string
 * in a viewer into a link.
 *
 * Membership is the whole test: a string links when it *is* a project file, so
 * there is no path-shaped heuristic to tune and no false positive to explain.
 * That only works if the set is complete, which is why untracked files are
 * indexed too — an agent handing over `untracked/runs/eval-v2.jsonl` is exactly
 * the case worth linking, and `git ls-files` would not know it.
 */

/**
 * Backstop against a pathological tree, not a working limit. Deliberately far
 * above the Source Control browser's 10,000-path corpus bound: that one caps
 * what a human scrolls, while this only holds strings for membership tests. A
 * real repository measured 15,365 paths, so a 10,000 bound silently dropped
 * files that should have linked.
 */
const MAX_INDEXED_PATHS = 200_000;

/**
 * Directories re-stat'ed to decide staleness. Measured at ~1.3µs per directory,
 * so this bounds the check to roughly 25ms — a repository wider than it uses
 * {@link WIDE_PROJECT_REBUILD_INTERVAL_MS} instead, because at that width the
 * sweep costs about as much as the rebuild it was meant to avoid (10,845
 * directories: 135ms to stat, 220ms to rebuild).
 */
const MAX_WATCHED_DIRECTORIES = 2_000;

/**
 * Shortest gap between staleness checks. Matches the Source Control status
 * poll: a file created now should link soon, not instantly, and a viewer can
 * ask several times while one screen renders.
 */
const RECHECK_INTERVAL_MS = 5_000;

/**
 * Rebuild gap for a project too wide to watch by directory. Its whole index is
 * re-read, so this trades staleness for not paying that on every view.
 */
const WIDE_PROJECT_REBUILD_INTERVAL_MS = 60_000;

const MAX_BUFFER = 32 * 1024 * 1024;

interface ProjectPathIndexEntry {
  paths: ReadonlySet<string>;
  /** Directory → mtime when indexed. A new or removed entry moves its mtime. */
  directoryMtimes: ReadonlyMap<string, number>;
  truncated: boolean;
  /** Advanced by each check that found nothing changed, so the recheck floor
   *  measures from the last look rather than from the build. */
  checkedAtMs: number;
}

const indexes = new Map<string, ProjectPathIndexEntry>();
const inFlight = new Map<string, Promise<ProjectPathIndexEntry>>();

function parseZeroTerminated(stdout: string): string[] {
  return stdout.split("\0").filter((value) => value.length > 0);
}

/**
 * Untracked paths from porcelain v2. Only `? <path>` records are untracked;
 * every other record type is tracked and already covered by `ls-files`.
 */
function parseUntrackedPaths(stdout: string): string[] {
  const paths: string[] = [];
  for (const record of parseZeroTerminated(stdout)) {
    if (record.startsWith("? ")) {
      paths.push(record.slice(2));
    }
  }
  return paths;
}

async function readProjectPaths(
  projectPath: string,
): Promise<{ paths: string[]; truncated: boolean }> {
  const [tracked, untracked] = await Promise.all([
    runGit(projectPath, [...GIT_DECODE_PATHS_ARGS, "ls-files", "-z"], {
      maxBuffer: MAX_BUFFER,
    }).then(
      (result) => parseZeroTerminated(result.stdout),
      () => [],
    ),
    runGit(
      projectPath,
      [
        ...GIT_DECODE_PATHS_ARGS,
        "status",
        "--porcelain=v2",
        "--untracked-files=all",
        "-z",
      ],
      { maxBuffer: MAX_BUFFER },
    ).then(
      (result) => parseUntrackedPaths(result.stdout),
      () => [],
    ),
  ]);

  // Untracked first: if the backstop ever truncates, keep the paths nothing
  // else can supply. Tracked files remain reachable through Source Control's
  // own file browser; an untracked run output is only ever named in content
  // like the manifest this feature exists for.
  const unique = new Set<string>();
  for (const path of untracked) unique.add(path);
  for (const path of tracked) unique.add(path);
  const paths = Array.from(unique);
  const truncated = paths.length > MAX_INDEXED_PATHS;
  return {
    paths: truncated ? paths.slice(0, MAX_INDEXED_PATHS) : paths,
    truncated,
  };
}

async function readDirectoryMtimes(
  projectPath: string,
  paths: readonly string[],
): Promise<Map<string, number>> {
  const directories = new Set<string>();
  for (const path of paths) {
    const parent = dirname(path);
    directories.add(parent === "." ? "" : parent);
    if (directories.size > MAX_WATCHED_DIRECTORIES) {
      // Too wide to watch; the time floor is the only staleness signal left.
      return new Map();
    }
  }

  const mtimes = new Map<string, number>();
  await Promise.all(
    Array.from(directories, async (directory) => {
      try {
        const stats = await stat(resolve(projectPath, directory));
        mtimes.set(directory, stats.mtimeMs);
      } catch {
        // A directory that vanished between listing and stat is itself a
        // change; leaving it absent makes the next check report stale.
      }
    }),
  );
  return mtimes;
}

async function isStale(
  projectPath: string,
  entry: ProjectPathIndexEntry,
  nowMs: number,
): Promise<boolean> {
  if (entry.directoryMtimes.size === 0) {
    // Too wide to watch by directory. Rebuilding is the only signal left, and
    // it costs as much as the sweep would, so pay it rarely rather than at the
    // ordinary recheck cadence.
    return nowMs - entry.checkedAtMs >= WIDE_PROJECT_REBUILD_INTERVAL_MS;
  }
  if (nowMs - entry.checkedAtMs < RECHECK_INTERVAL_MS) return false;

  for (const [directory, mtimeMs] of entry.directoryMtimes) {
    try {
      const stats = await stat(resolve(projectPath, directory));
      if (stats.mtimeMs !== mtimeMs) return true;
    } catch {
      return true;
    }
  }
  entry.checkedAtMs = nowMs;
  return false;
}

async function buildIndex(
  projectPath: string,
  nowMs: number,
): Promise<ProjectPathIndexEntry> {
  const { paths, truncated } = await readProjectPaths(projectPath);
  const directoryMtimes = await readDirectoryMtimes(projectPath, paths);
  return {
    paths: new Set(paths),
    directoryMtimes,
    truncated,
    checkedAtMs: nowMs,
  };
}

export interface ProjectPathIndex {
  /** Whether this exact project-relative path is a file in the project. */
  has(path: string): boolean;
  /** Existing paths from one content-resolution batch. */
  findExisting(paths: readonly string[]): Promise<ReadonlySet<string>>;
  /** Indexed path count, for diagnostics. */
  size: number;
  /** True when the project exceeded {@link MAX_INDEXED_PATHS}. */
  truncated: boolean;
}

/**
 * The project's path set, rebuilt when a directory's mtime shows that its
 * entries changed. A directory's mtime moves when a file is created, removed,
 * or renamed inside it, which is exactly the set of changes that can make a
 * link appear or dangle; edits to a file's *contents* do not move it and do
 * not need to.
 */
export async function getProjectPathIndex(
  projectPath: string,
  nowMs: number = Date.now(),
): Promise<ProjectPathIndex> {
  const existing = indexes.get(projectPath);
  if (existing && !(await isStale(projectPath, existing, nowMs))) {
    return toPublicIndex(existing);
  }

  const pending = inFlight.get(projectPath);
  if (pending) return toPublicIndex(await pending);

  const build = buildIndex(projectPath, nowMs).finally(() => {
    inFlight.delete(projectPath);
  });
  inFlight.set(projectPath, build);
  try {
    const entry = await build;
    indexes.set(projectPath, entry);
    return toPublicIndex(entry);
  } catch {
    // Never fail a file view over its links; serve whatever was last known.
    return toPublicIndex(
      existing ?? {
        paths: new Set<string>(),
        directoryMtimes: new Map(),
        truncated: false,
        checkedAtMs: nowMs,
      },
    );
  }
}

function toPublicIndex(entry: ProjectPathIndexEntry): ProjectPathIndex {
  return {
    has: (path: string) => entry.paths.has(path),
    findExisting: async (paths: readonly string[]) =>
      new Set(paths.filter((path) => entry.paths.has(path))),
    size: entry.paths.size,
    truncated: entry.truncated,
  };
}

/**
 * Drop a project's cached paths. Call when something already knows the tree
 * moved — a completed file mutation, a branch change — instead of waiting for
 * the next directory-mtime check to notice.
 */
export function invalidateProjectPathIndex(projectPath: string): void {
  indexes.delete(projectPath);
}

export const __test__ = {
  MAX_INDEXED_PATHS,
  MAX_WATCHED_DIRECTORIES,
  RECHECK_INTERVAL_MS,
  WIDE_PROJECT_REBUILD_INTERVAL_MS,
  reset: () => {
    indexes.clear();
    inFlight.clear();
  },
};
