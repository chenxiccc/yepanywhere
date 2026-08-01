/** Exact source capture and append-only git-object pinning. */

import { spawn } from "node:child_process";
import type {
  ReviewCapture,
  ReviewSourceProjection,
} from "@yep-anywhere/shared";
import { runGit } from "../git/gitExec.js";
import { HttpError } from "../middleware/error-handler.js";
import {
  repositoryFilePath,
  repositoryRelativePath,
} from "./repositoryPath.js";

export const SOURCE_REVIEW_CAPTURE_REF =
  "refs/yep/source-review/captures" as const;
const MAX_PIN_RETRIES = 12;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export class ReviewCaptureService {
  async capture(
    projectPath: string,
    projection: ReviewSourceProjection,
  ): Promise<ReviewCapture> {
    const path = repositoryRelativePath(projection.path);
    const safeProjection: ReviewSourceProjection =
      projection.kind === "revision"
        ? {
            kind: "revision",
            revision: projection.revision,
            path,
            side: projection.side,
          }
        : { kind: projection.kind, path, side: projection.side };
    const captureBlobId = await resolveProjectionBlob(
      projectPath,
      safeProjection,
    );
    await this.pin(projectPath, captureBlobId);
    return {
      status: "captured",
      captureBlobId,
      projection: safeProjection,
    };
  }

  /** Add a blob to the shared-worktree ref with compare-and-swap retries. */
  async pin(projectPath: string, blobId: string): Promise<void> {
    if (!OBJECT_ID_RE.test(blobId)) {
      throw new Error(`Invalid source-review capture object id: ${blobId}`);
    }
    await assertBlob(projectPath, blobId);

    for (let attempt = 0; attempt < MAX_PIN_RETRIES; attempt++) {
      const current = await readCaptureTree(projectPath);
      if (current.blobIds.has(blobId)) return;
      const nextIds = [...current.blobIds, blobId].sort();
      const nextTree = await writeCaptureTree(projectPath, nextIds);
      const expected = current.treeId ?? "0".repeat(nextTree.length);
      try {
        await runGit(projectPath, [
          "update-ref",
          SOURCE_REVIEW_CAPTURE_REF,
          nextTree,
          expected,
        ]);
        return;
      } catch {
        // A concurrent writer may have advanced the ref. Re-read and union.
      }
    }
    throw new Error("Could not update the source-review capture ref after retries");
  }
}

async function resolveProjectionBlob(
  projectPath: string,
  projection: ReviewSourceProjection,
): Promise<string> {
  try {
    let stdout: string;
    if (projection.kind === "worktree") {
      const absolutePath = await repositoryFilePath(projectPath, projection.path);
      ({ stdout } = await runGit(projectPath, [
        "hash-object",
        "-w",
        "--",
        absolutePath,
      ]));
    } else if (projection.kind === "index") {
      ({ stdout } = await runGit(projectPath, [
        "rev-parse",
        "--verify",
        `:${projection.path}`,
      ]));
    } else {
      ({ stdout } = await runGit(projectPath, [
        "rev-parse",
        "--verify",
        `${projection.revision}:${projection.path}`,
      ]));
    }
    const blobId = stdout.trim();
    if (!OBJECT_ID_RE.test(blobId)) throw new Error("git returned an invalid blob id");
    await assertBlob(projectPath, blobId);
    return blobId;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(
      400,
      `Could not capture the rendered source projection for ${projection.path}`,
    );
  }
}

async function assertBlob(projectPath: string, blobId: string): Promise<void> {
  await runGit(projectPath, ["cat-file", "-e", `${blobId}^{blob}`]);
}

async function readCaptureTree(projectPath: string): Promise<{
  treeId: string | null;
  blobIds: Set<string>;
}> {
  let refTarget: string;
  try {
    const result = await runGit(projectPath, [
      "rev-parse",
      "--verify",
      SOURCE_REVIEW_CAPTURE_REF,
    ]);
    refTarget = result.stdout.trim();
  } catch {
    return { treeId: null, blobIds: new Set() };
  }
  let treeId: string;
  try {
    const result = await runGit(projectPath, [
      "rev-parse",
      "--verify",
      `${refTarget}^{tree}`,
    ]);
    treeId = result.stdout.trim();
  } catch {
    throw new Error("Source-review capture ref does not point to a tree");
  }
  if (!OBJECT_ID_RE.test(treeId)) {
    throw new Error("Source-review capture ref does not point to a valid tree");
  }
  const { stdout } = await runGit(projectPath, [
    "ls-tree",
    "-z",
    "--name-only",
    treeId,
  ]);
  const blobIds = new Set(stdout.split("\0").filter(Boolean));
  for (const id of blobIds) {
    if (!OBJECT_ID_RE.test(id)) {
      throw new Error("Source-review capture tree has an invalid entry name");
    }
  }
  return { treeId, blobIds };
}

async function writeCaptureTree(
  projectPath: string,
  blobIds: string[],
): Promise<string> {
  const input = blobIds.map((id) => `100644 blob ${id}\t${id}\0`).join("");
  const output = await runGitWithInput(projectPath, ["mktree", "-z"], input);
  const treeId = output.trim();
  if (!OBJECT_ID_RE.test(treeId)) {
    throw new Error("git mktree returned an invalid object id");
  }
  return treeId;
}

function runGitWithInput(
  projectPath: string,
  args: string[],
  input: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", projectPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("git mktree timed out"));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve(Buffer.concat(stdout).toString("utf-8"));
      else reject(new Error(Buffer.concat(stderr).toString("utf-8")));
    });
    child.stdin.end(input);
  });
}
