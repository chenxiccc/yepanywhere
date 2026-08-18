import type { ReviewSourceProjection } from "@yep-anywhere/shared";
import type { Context } from "hono";
import { gitDiffReportsBinary } from "../git/binaryDiff.js";
import { skippedBinaryGitDiffResult } from "../git/diffPreviewGuards.js";
import { buildGitDiffResultFromBytes } from "../git/diffResult.js";
import { readGitDiffFileChanges } from "../git/fileChanges.js";
import { runGit, runGitBytes } from "../git/gitExec.js";
import type { ProjectScanner } from "../projects/scanner.js";
import { resolveProjectPath } from "./projectParam.js";

export interface GitProjectionDeps {
  scanner: ProjectScanner;
}

const SHA_RE = /^[0-9a-f]{4,64}$/i;
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const PROJECTION_MAX_BUFFER = 16 * 1024 * 1024;

export function isValidProjectionSha(value: string): boolean {
  return SHA_RE.test(value);
}

export async function compareFiles(
  cwd: string,
  baseSha: string,
  headSha: string,
) {
  return readGitDiffFileChanges(cwd, [baseSha, headSha], {
    maxBuffer: PROJECTION_MAX_BUFFER,
  });
}

export async function resolveCommit(cwd: string, rev: string): Promise<string> {
  const { stdout } = await runGit(cwd, [
    "rev-parse",
    "--verify",
    `${rev}^{commit}`,
  ]);
  return stdout.trim();
}

export async function resolveFirstParentOrEmptyTree(
  cwd: string,
  selectedSha: string,
): Promise<string> {
  const { stdout } = await runGit(cwd, ["cat-file", "-p", selectedSha]);
  const parentLine = stdout
    .split("\n")
    .find((line) => line.startsWith("parent "));
  if (!parentLine) return EMPTY_TREE_SHA;
  return resolveCommit(cwd, parentLine.slice("parent ".length));
}

export async function renderComparisonDiff(
  c: Context,
  deps: GitProjectionDeps,
  allowTreeBase: boolean,
) {
  const projectPath = await resolveProjectPath(c, deps.scanner);
  if (typeof projectPath !== "string") return projectPath;
  const projectId = c.req.param("projectId");
  if (!projectId) return c.json({ error: "Missing project id" }, 400);

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
  if (body.origPath !== undefined && typeof body.origPath !== "string") {
    return c.json({ error: "Invalid origPath" }, 400);
  }
  if (body.fullContext !== undefined && typeof body.fullContext !== "boolean") {
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
      allowTreeBase
        ? resolveCommitOrTree(projectPath, body.baseSha)
        : resolveCommit(projectPath, body.baseSha),
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
    const result = await buildGitDiffResultFromBytes({
      path: body.path,
      oldContent,
      newContent,
      markdownProject: {
        id: projectId,
        path: projectPath,
      },
      fullContext: body.fullContext,
      ignoreWhitespace: body.ignoreWhitespace,
    });
    result.reviewProjections = {
      old: revisionProjection(
        baseSha,
        reviewOldPath(body.path, body.status, body.origPath),
        "old",
      ),
      new: revisionProjection(headSha, body.path, "new"),
    };
    return c.json(result);
  } catch (err) {
    return gitError(c, err);
  }
}

export function gitError(c: Context, err: unknown): Response {
  const message = err instanceof Error ? err.message : "git command failed";
  return c.json({ error: message }, 500);
}

async function resolveCommitOrTree(cwd: string, rev: string): Promise<string> {
  const { stdout } = await runGit(cwd, [
    "rev-parse",
    "--verify",
    `${rev}^{tree}`,
  ]);
  const resolvedTree = stdout.trim();
  return resolvedTree === EMPTY_TREE_SHA
    ? EMPTY_TREE_SHA
    : resolveCommit(cwd, rev);
}

function reviewOldPath(
  path: string,
  status: string,
  origPath: string | undefined,
): string {
  const letter = status[0]?.toUpperCase();
  return (letter === "R" || letter === "C") && origPath ? origPath : path;
}

function revisionProjection(
  revision: string,
  path: string,
  side: "old" | "new",
): ReviewSourceProjection {
  return { kind: "revision", revision, path, side };
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
    const { stdout } = await runGitBytes(cwd, ["show", `${revision}:${path}`], {
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
