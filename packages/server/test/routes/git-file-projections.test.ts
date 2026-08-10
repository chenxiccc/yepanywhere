import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitDiffResult,
  type GitFileProjectionManifest,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitFileProjectionRoutes } from "../../src/routes/git-file-projections.js";
import type { Project } from "../../src/supervisor/types.js";

const execFileAsync = promisify(execFile);

function createRoutesForProject(projectPath: string) {
  const projectId = toUrlProjectId(projectPath);
  const project: Project = {
    id: projectId,
    path: projectPath,
    name: "repo",
    sessionCount: 0,
    sessionDir: join(projectPath, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
  return {
    projectId,
    routes: createGitFileProjectionRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
    }),
  };
}

describe("git file projection routes", () => {
  let dir: string;
  let firstSha: string;
  let headSha: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
    return stdout.trim();
  }

  async function commitAll(message: string): Promise<string> {
    await git("add", "-A");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-git-file-projections-"));
    await git("init");
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");

    await writeFile(join(dir, "changed.txt"), "initial\n");
    await writeFile(join(dir, "reverted.txt"), "initial\n");
    firstSha = await commitAll("initial");

    await writeFile(join(dir, "changed.txt"), "committed\n");
    await writeFile(join(dir, "reverted.txt"), "committed\n");
    await writeFile(join(dir, "head-only.txt"), "from head\n");
    headSha = await commitAll("head change");

    await writeFile(join(dir, "changed.txt"), "working tree\n");
    await writeFile(join(dir, "reverted.txt"), "initial\n");
    await writeFile(join(dir, "untracked.txt"), "untracked\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists exact HEAD and first-parent worktree projections", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const response = await routes.request(`/${projectId}/git/file-projections`);
    const body = (await response.json()) as GitFileProjectionManifest;
    const worktreePaths = body.worktreeFiles.map((file) => file.path);
    const cumulativePaths = body.cumulativeFiles.map((file) => file.path);

    expect(response.status).toBe(200);
    expect(body.headSha).toBe(headSha);
    expect(body.baseSha).toBe(firstSha);
    expect(worktreePaths).toEqual([
      "changed.txt",
      "reverted.txt",
      "untracked.txt",
    ]);
    expect(cumulativePaths).toEqual([
      "changed.txt",
      "head-only.txt",
      "untracked.txt",
    ]);
  });

  it.each([
    {
      mode: "worktree",
      removed: "-committed",
      added: "+working tree",
      oldRevision: () => headSha,
    },
    {
      mode: "cumulative",
      removed: "-initial",
      added: "+working tree",
      oldRevision: () => firstSha,
    },
  ] as const)("renders the $mode projection", async (testCase) => {
    const { projectId, routes } = createRoutesForProject(dir);
    const response = await routes.request(
      `/${projectId}/git/file-projection-diff`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "changed.txt", mode: testCase.mode }),
      },
    );
    const body = (await response.json()) as GitDiffResult;
    const lines = body.structuredPatch.flatMap((hunk) => hunk.lines);

    expect(response.status).toBe(200);
    expect(lines).toContain(testCase.removed);
    expect(lines).toContain(testCase.added);
    expect(body.reviewProjections).toEqual({
      old: {
        kind: "revision",
        revision: testCase.oldRevision(),
        path: "changed.txt",
        side: "old",
      },
      new: { kind: "worktree", path: "changed.txt", side: "new" },
    });
  });

  it("rejects a projection that has no net diff", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const response = await routes.request(
      `/${projectId}/git/file-projection-diff`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: "reverted.txt", mode: "cumulative" }),
      },
    );

    expect(response.status).toBe(404);
  });
});
