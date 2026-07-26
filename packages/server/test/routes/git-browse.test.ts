import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitCommitDetail,
  type GitCommitListResult,
  type GitDiffResult,
  anchorFromPatch,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitBrowseRoutes } from "../../src/routes/git-browse.js";
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
    routes: createGitBrowseRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
    }),
  };
}

describe("git-browse routes", () => {
  let dir: string;
  const shas: Record<string, string> = {};

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
    dir = await mkdtemp(join(tmpdir(), "yep-git-browse-"));
    await git("init");
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");

    await writeFile(join(dir, "a.ts"), "line1\nline2\nline3\n");
    shas.c1 = await commitAll("add a");

    await writeFile(join(dir, "a.ts"), "line1\nline2 changed\nline3\nline4\n");
    await writeFile(join(dir, "b.ts"), "new file\n");
    shas.c2 = await commitAll("modify a add b");

    // Rename a.ts -> d.ts with a small edit so -M detects it as a rename.
    await rename(join(dir, "a.ts"), join(dir, "d.ts"));
    await writeFile(
      join(dir, "d.ts"),
      "line1\nline2 changed\nline3\nline4\nline5\n",
    );
    shas.c3 = await commitAll("rename a to d");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists commits newest-first with paging", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const page = await routes.request(`/${projectId}/git/commits?limit=2`);
    const body = (await page.json()) as GitCommitListResult;

    expect(page.status).toBe(200);
    expect(body.hasMore).toBe(true);
    expect(body.commits).toHaveLength(2);
    expect(body.commits[0]?.subject).toBe("rename a to d");
    expect(body.commits[0]?.hash).toBe(shas.c3);
    expect(body.commits[1]?.subject).toBe("modify a add b");

    const rest = await routes.request(
      `/${projectId}/git/commits?limit=2&skip=2`,
    );
    const restBody = (await rest.json()) as GitCommitListResult;
    expect(restBody.hasMore).toBe(false);
    expect(restBody.commits).toHaveLength(1);
    expect(restBody.commits[0]?.subject).toBe("add a");
  });

  it("returns a commit's metadata and changed-file list", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit/${shas.c2}`);
    const body = (await res.json()) as GitCommitDetail;

    expect(res.status).toBe(200);
    expect(body.subject).toBe("modify a add b");
    expect(body.files).toContainEqual({
      path: "a.ts",
      status: "M",
      staged: false,
      linesAdded: 2,
      linesDeleted: 1,
    });
    expect(body.files).toContainEqual({
      path: "b.ts",
      status: "A",
      staged: false,
      linesAdded: 1,
      linesDeleted: 0,
    });
  });

  it("marks a rename with its original path", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit/${shas.c3}`);
    const body = (await res.json()) as GitCommitDetail;

    const renamed = body.files.find((f) => f.path === "d.ts");
    expect(renamed?.status).toBe("R");
    expect(renamed?.origPath).toBe("a.ts");
  });

  it("computes a per-file commit diff with data-diff-line addressing", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: shas.c2, path: "a.ts", status: "M" }),
    });
    const body = (await res.json()) as GitDiffResult;

    expect(res.status).toBe(200);
    expect(body.previewSkipped).toBeUndefined();
    expect(body.diffHtml).toContain("data-diff-line");
    const lines = body.structuredPatch.flatMap((h) => h.lines);
    expect(lines).toContain("+line2 changed");
    expect(lines).toContain("-line2");

    // The flat index emitted in diffHtml must invert to the same line via the
    // shared anchor helper (the P1↔P2 contract, now for commit diffs).
    const addedFlat = lines.indexOf("+line2 changed");
    const anchor = anchorFromPatch(body.structuredPatch, addedFlat);
    expect(anchor?.side).toBe("new");
    expect(body.diffHtml).toContain(`data-diff-line="${addedFlat}"`);
  });

  it("treats an added file as fully new (empty old side)", async () => {
    const { projectId, routes } = createRoutesForProject(dir);

    const res = await routes.request(`/${projectId}/git/commit-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sha: shas.c2, path: "b.ts", status: "A" }),
    });
    const body = (await res.json()) as GitDiffResult;

    expect(res.status).toBe(200);
    const lines = body.structuredPatch.flatMap((h) => h.lines);
    expect(lines).toContain("+new file");
    expect(lines.some((l) => l.startsWith("-"))).toBe(false);
  });

  it("rejects a non-hex commit id", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const res = await routes.request(`/${projectId}/git/commit/not-a-sha`);
    expect(res.status).toBe(400);
  });
});
