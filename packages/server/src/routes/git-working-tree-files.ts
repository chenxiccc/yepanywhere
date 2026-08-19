import type {
  GitUntrackedFileListResult,
  GitWorkingTreeFile,
  GitWorkingTreeFileListResult,
  GitWorktreeCoverage,
} from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { GIT_DECODE_PATHS_ARGS, runGit } from "../git/gitExec.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { DirtyFileEditorService } from "../services/DirtyFileEditorService.js";
import { GitUntrackedCacheService } from "../services/GitUntrackedCacheService.js";
import { resolveProjectPath } from "./projectParam.js";

const DEFAULT_WORKING_TREE_FILE_LIMIT = 50_000;
const MAX_WORKING_TREE_FILE_LIMIT = 50_000;
const WORKING_TREE_FILE_MAX_BUFFER = 64 * 1024 * 1024;

export interface GitWorkingTreeFilesDeps {
  scanner: ProjectScanner;
  dataDir: string;
  dirtyFileEditorService?: DirtyFileEditorService;
  untrackedCache?: GitUntrackedCacheService;
}

/**
 * Read-only current-content inventory for the Working Tree browser. The three
 * Git queries keep work proportional to repository size rather than status-row
 * count, and Git remains the owner of ignore/exclude semantics.
 */
export function createGitWorkingTreeFilesRoutes(
  deps: GitWorkingTreeFilesDeps,
): Hono {
  const routes = new Hono();
  const untrackedCache =
    deps.untrackedCache ??
    new GitUntrackedCacheService({ dataDir: deps.dataDir });

  routes.get("/:projectId/git/working-tree-files", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const limit = clampLimit(c.req.query("limit"));
    const coverage = {
      tracked: queryEnabled(c.req.query("tracked"), true),
      untracked: queryEnabled(c.req.query("untracked"), true),
      ignored: queryEnabled(c.req.query("ignored"), false),
    };
    try {
      const untracked = coverage.untracked
        ? await untrackedCache.all(projectPath)
        : undefined;
      return c.json(
        await listWorkingTreeFiles(projectPath, limit, untracked?.files, {
          coverage,
          untrackedTruncated: untracked?.truncated,
        }),
      );
    } catch (error) {
      return gitError(c, error);
    }
  });

  routes.get("/:projectId/git/untracked-files", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    const path = c.req.query("path");
    if (path !== undefined && !isValidFolderPath(path)) {
      return c.json({ error: "Invalid untracked folder path" }, 400);
    }

    try {
      const result = await untrackedCache.query(projectPath, {
        ...(path ? { path } : {}),
        ...(c.req.query("q") ? { q: c.req.query("q") } : {}),
      });
      return c.json(decorateLastEditors(deps, projectPath, result));
    } catch (error) {
      return gitError(c, error);
    }
  });

  return routes;
}

export async function listWorkingTreeFiles(
  cwd: string,
  limit = DEFAULT_WORKING_TREE_FILE_LIMIT,
  cachedUntracked?: string[],
  options: {
    coverage?: GitWorktreeCoverage;
    untrackedTruncated?: boolean;
  } = {},
): Promise<GitWorkingTreeFileListResult> {
  const coverage = options.coverage ?? {
    tracked: true,
    untracked: true,
    ignored: false,
  };
  const [cached, deleted, untracked, ignored] = await Promise.all([
    coverage.tracked ? listPaths(cwd, ["--cached"]) : Promise.resolve([]),
    coverage.tracked ? listPaths(cwd, ["--deleted"]) : Promise.resolve([]),
    coverage.untracked
      ? (cachedUntracked ?? listPaths(cwd, ["--others", "--exclude-standard"]))
      : Promise.resolve([]),
    coverage.ignored
      ? listPaths(cwd, ["--others", "--ignored", "--exclude-standard"])
      : Promise.resolve([]),
  ]);
  const deletedPaths = new Set(deleted);
  const trackedPaths = new Set(
    cached.filter((path) => !deletedPaths.has(path)),
  );
  const files: GitWorkingTreeFile[] = [
    ...Array.from(trackedPaths, (path) => ({
      path,
      tracked: true,
      kind: "tracked" as const,
    })),
    ...untracked
      .filter((path) => !trackedPaths.has(path))
      .map((path) => ({ path, tracked: false, kind: "untracked" as const })),
    ...ignored
      .filter((path) => !trackedPaths.has(path))
      .map((path) => ({ path, tracked: false, kind: "ignored" as const })),
  ].sort((a, b) => comparePaths(a.path, b.path));
  const truncated = Boolean(options.untrackedTruncated) || files.length > limit;

  return {
    files: files.length > limit ? files.slice(0, limit) : files,
    truncated,
    limit,
  };
}

async function listPaths(cwd: string, flags: string[]): Promise<string[]> {
  const { stdout } = await runGit(
    cwd,
    [...GIT_DECODE_PATHS_ARGS, "ls-files", "-z", ...flags],
    { maxBuffer: WORKING_TREE_FILE_MAX_BUFFER },
  );
  const paths = stdout.split("\0");
  if (paths.at(-1) === "") paths.pop();
  return paths;
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function decorateLastEditors(
  deps: GitWorkingTreeFilesDeps,
  projectPath: string,
  result: GitUntrackedFileListResult,
): GitUntrackedFileListResult {
  const lastEditors =
    deps.dirtyFileEditorService?.editorsForPaths(projectPath, result.files) ??
    {};
  return Object.keys(lastEditors).length > 0
    ? { ...result, lastEditors }
    : result;
}

function isValidFolderPath(path: string): boolean {
  return (
    path.endsWith("/") &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path
      .split("/")
      .every((segment, index, segments) =>
        index === segments.length - 1
          ? segment === ""
          : segment !== "" && segment !== "." && segment !== "..",
      )
  );
}

function clampLimit(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_WORKING_TREE_FILE_LIMIT;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) return DEFAULT_WORKING_TREE_FILE_LIMIT;
  return Math.min(MAX_WORKING_TREE_FILE_LIMIT, Math.max(1, value));
}

function queryEnabled(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  return raw === "1" || raw === "true";
}

function gitError(c: Context, error: unknown): Response {
  const message = error instanceof Error ? error.message : "git command failed";
  return c.json({ error: message }, 500);
}
