import type { GitRevisionComparison } from "@yep-anywhere/shared";
import type { Context } from "hono";
import { Hono } from "hono";
import { gitDiffReportsBinary } from "../git/binaryDiff.js";
import { skippedBinaryGitDiffResult } from "../git/diffPreviewGuards.js";
import { buildGitDiffResultFromBytes } from "../git/diffResult.js";
import { buildGitFileChanges } from "../git/fileChanges.js";
import {
  GIT_DECODE_PATHS_ARGS,
  runGit,
  runGitBytes,
} from "../git/gitExec.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { resolveProjectPath } from "./projectParam.js";

export interface GitProjectionDeps {
  scanner: ProjectScanner;
}

const SHA_RE = /^[0-9a-f]{4,64}$/i;
const PROJECTION_MAX_BUFFER = 16 * 1024 * 1024;

/**
 * Optional Source Control projections added after the base source-review
 * contract: a direct selected-revision-to-HEAD comparison and whitespace-aware
 * rendering. Keeping these routes in their own module gives the capability
 * registry an exact ownership boundary.
 */
export function createGitProjectionRoutes(deps: GitProjectionDeps): Hono {
  const routes = new Hono();

  routes.get("/:projectId/git/compare/:sha", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    const requestedBase = c.req.param("sha");
    if (!SHA_RE.test(requestedBase)) {
      return c.json({ error: "Invalid commit id" }, 400);
    }

    try {
      const [baseSha, headSha] = await Promise.all([
        resolveCommit(projectPath, requestedBase),
        resolveCommit(projectPath, "HEAD"),
      ]);
      const files = await compareFiles(projectPath, baseSha, headSha);
      return c.json({
        baseSha,
        headSha,
        files,
      } satisfies GitRevisionComparison);
    } catch (err) {
      return gitError(c, err);
    }
  });

  routes.post("/:projectId/git/compare-diff", async (c) => {
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;

    let body: {
      baseSha?: unknown;
      headSha?: unknown;
      path?: unknown;
      status?: unknown;
      origPath?: unknown;
      fullContext?: unknown;
      ignoreWhitespace?: unknown;
    };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }

    if (typeof body.baseSha !== "string" || !SHA_RE.test(body.baseSha)) {
      return c.json({ error: "Invalid base commit id" }, 400);
    }
    if (typeof body.headSha !== "string" || !SHA_RE.test(body.headSha)) {
      return c.json({ error: "Invalid HEAD commit id" }, 400);
    }
    if (typeof body.path !== "string" || typeof body.status !== "string") {
      return c.json({ error: "Missing required fields: path, status" }, 400);
    }
    if (
      body.origPath !== undefined &&
      typeof body.origPath !== "string"
    ) {
      return c.json({ error: "Invalid origPath" }, 400);
    }
    if (
      body.fullContext !== undefined &&
      typeof body.fullContext !== "boolean"
    ) {
      return c.json({ error: "Invalid fullContext" }, 400);
    }
    if (
      body.ignoreWhitespace !== undefined &&
      typeof body.ignoreWhitespace !== "boolean"
    ) {
      return c.json({ error: "Invalid ignoreWhitespace" }, 400);
    }

    try {
      const [baseSha, headSha] = await Promise.all([
        resolveCommit(projectPath, body.baseSha),
        resolveCommit(projectPath, body.headSha),
      ]);
      if (
        await gitDiffReportsBinary(
          projectPath,
          ["diff", "-M", baseSha, headSha],
          body.path,
        )
      ) {
        return c.json(skippedBinaryGitDiffResult());
      }
      const { oldContent, newContent } = await getRevisionFileVersions(
        projectPath,
        baseSha,
        headSha,
        body.path,
        body.status,
        body.origPath,
      );
      return c.json(
        await buildGitDiffResultFromBytes({
          toolUseId: "git-compare-diff",
          path: body.path,
          oldContent,
          newContent,
          fullContext: body.fullContext,
          ignoreWhitespace: body.ignoreWhitespace,
        }),
      );
    } catch (err) {
      return gitError(c, err);
    }
  });

  return routes;
}

async function compareFiles(
  cwd: string,
  baseSha: string,
  headSha: string,
) {
  const [nameStatus, numstat] = await Promise.all([
    runGit(
      cwd,
      [
        ...GIT_DECODE_PATHS_ARGS,
        "diff",
        "--name-status",
        "-z",
        "-M",
        baseSha,
        headSha,
      ],
      { maxBuffer: PROJECTION_MAX_BUFFER },
    ),
    runGit(
      cwd,
      [
        ...GIT_DECODE_PATHS_ARGS,
        "diff",
        "--numstat",
        "-z",
        "-M",
        baseSha,
        headSha,
      ],
      { maxBuffer: PROJECTION_MAX_BUFFER },
    ),
  ]);
  return buildGitFileChanges(nameStatus.stdout, numstat.stdout);
}

async function resolveCommit(cwd: string, rev: string): Promise<string> {
  const { stdout } = await runGit(cwd, [
    "rev-parse",
    "--verify",
    `${rev}^{commit}`,
  ]);
  return stdout.trim();
}

async function getRevisionFileVersions(
  cwd: string,
  baseSha: string,
  headSha: string,
  path: string,
  status: string,
  origPath?: string,
): Promise<{ oldContent: Uint8Array; newContent: Uint8Array }> {
  const letter = status[0]?.toUpperCase() ?? "M";
  if (letter === "A") {
    return {
      oldContent: Buffer.alloc(0),
      newContent: await showAt(cwd, headSha, path),
    };
  }
  if (letter === "D") {
    return {
      oldContent: await showAt(cwd, baseSha, path),
      newContent: Buffer.alloc(0),
    };
  }

  const oldPath =
    (letter === "R" || letter === "C") && origPath ? origPath : path;
  const [oldContent, newContent] = await Promise.all([
    showAt(cwd, baseSha, oldPath),
    showAt(cwd, headSha, path),
  ]);
  return { oldContent, newContent };
}

async function showAt(
  cwd: string,
  revision: string,
  path: string,
): Promise<Uint8Array> {
  try {
    const { stdout } = await runGitBytes(cwd, [
      "show",
      `${revision}:${path}`,
    ], {
      maxBuffer: PROJECTION_MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    if (
      (err as NodeJS.ErrnoException).code ===
      "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ) {
      throw err;
    }
    return Buffer.alloc(0);
  }
}

function gitError(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : "git command failed";
  return c.json({ error: message }, 500);
}
