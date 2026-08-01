import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitDiffResult,
  type GitRevisionComparison,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitProjectionRoutes } from "../../src/routes/git-projections.js";
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
    routes: createGitProjectionRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
    }),
  };
}

describe("git projection routes", () => {
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
    dir = await mkdtemp(join(tmpdir(), "yep-git-projections-"));
    await git("init");
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");

    await writeFile(join(dir, "app.ts"), "const value = 1;\nkeep\n");
    firstSha = await commitAll("initial");

    await writeFile(join(dir, "app.ts"), "const   value=1;\nkeep changed\n");
    await writeFile(join(dir, "later.ts"), "added later\n");
    headSha = await commitAll("follow-up");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists a direct selected-revision-to-pinned-HEAD comparison", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const response = await routes.request(
      `/${projectId}/git/compare/${firstSha}`,
    );
    const body = (await response.json()) as GitRevisionComparison;

    expect(response.status).toBe(200);
    expect(body.baseSha).toBe(firstSha);
    expect(body.headSha).toBe(headSha);
    expect(body.files).toContainEqual({
      path: "app.ts",
      status: "M",
      staged: false,
      linesAdded: 2,
      linesDeleted: 2,
    });
    expect(body.files).toContainEqual({
      path: "later.ts",
      status: "A",
      staged: false,
      linesAdded: 1,
      linesDeleted: 0,
    });
  });

  it("renders one file between the exact supplied revisions", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const response = await routes.request(`/${projectId}/git/compare-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseSha: firstSha,
        headSha,
        path: "app.ts",
        status: "M",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    const lines = body.structuredPatch.flatMap((hunk) => hunk.lines);
    expect(lines).toContain("-keep");
    expect(lines).toContain("+keep changed");
    expect(body.reviewProjections).toEqual({
      old: {
        kind: "revision",
        revision: firstSha,
        path: "app.ts",
        side: "old",
      },
      new: {
        kind: "revision",
        revision: headSha,
        path: "app.ts",
        side: "new",
      },
    });
  });

  it("pins HEAD so later commits cannot alter an open comparison", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const comparisonResponse = await routes.request(
      `/${projectId}/git/compare/${firstSha}`,
    );
    const comparison =
      (await comparisonResponse.json()) as GitRevisionComparison;

    await writeFile(join(dir, "app.ts"), "entirely newer content\n");
    await commitAll("move HEAD again");

    const diffResponse = await routes.request(
      `/${projectId}/git/compare-diff`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          baseSha: comparison.baseSha,
          headSha: comparison.headSha,
          path: "app.ts",
          status: "M",
        }),
      },
    );
    const diff = (await diffResponse.json()) as GitDiffResult;
    const lines = diff.structuredPatch.flatMap((hunk) => hunk.lines);

    expect(lines).toContain("+keep changed");
    expect(lines.join("\n")).not.toContain("entirely newer content");
  });

  it("applies ignore-whitespace to the direct comparison", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const response = await routes.request(`/${projectId}/git/compare-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseSha: firstSha,
        headSha,
        path: "app.ts",
        status: "M",
        ignoreWhitespace: true,
      }),
    });
    const body = (await response.json()) as GitDiffResult;
    const lines = body.structuredPatch.flatMap((hunk) => hunk.lines);

    expect(response.status).toBe(200);
    expect(lines).toContain(" const   value=1;");
    expect(lines).not.toContain("-const value = 1;");
    expect(lines).not.toContain("+const   value=1;");
    expect(lines).toContain("-keep");
    expect(lines).toContain("+keep changed");
  });

  it("skips binary files in exact revision comparisons", async () => {
    await writeFile(
      join(dir, "compiled.cache"),
      Buffer.from([0x43, 0x41, 0x43, 0x48, 0, 0xff]),
    );
    const binaryHead = await commitAll("add binary cache");
    const { projectId, routes } = createRoutesForProject(dir);

    const response = await routes.request(`/${projectId}/git/compare-diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        baseSha: headSha,
        headSha: binaryHead,
        path: "compiled.cache",
        status: "A",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: { reason: "binary" },
    });
  });
});
