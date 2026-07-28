import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitDiffResult,
  type GitIntegrationOptionsResult,
  type GitPushResult,
  type GitStatusInfo,
  type GitUntrackedFolderInfo,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitStatusRoutes } from "../../src/routes/git-status.js";
import type { Project } from "../../src/supervisor/types.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

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
    routes: createGitStatusRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
    }),
  };
}

async function commitFile(
  repoDir: string,
  fileName: string,
  content: string,
  message: string,
): Promise<void> {
  await writeFile(join(repoDir, fileName), content);
  await runGit(repoDir, ["add", fileName]);
  await runGit(repoDir, ["commit", "-m", message]);
}

describe("git-status routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yep-git-status-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  async function createRepoWithUpstream(): Promise<string> {
    const remoteDir = join(tempDir, "remote.git");
    const repoDir = join(tempDir, "repo");

    await mkdir(repoDir, { recursive: true });
    await execFileAsync("git", ["init", "--bare", remoteDir]);
    await execFileAsync("git", ["init", repoDir]);
    await runGit(repoDir, ["config", "user.email", "ya-test@example.com"]);
    await runGit(repoDir, ["config", "user.name", "YA Test"]);
    await commitFile(repoDir, "README.md", "hello\n", "Initial commit");
    await runGit(repoDir, ["remote", "add", "origin", remoteDir]);
    await runGit(repoDir, ["push", "-u", "origin", "HEAD"]);

    return repoDir;
  }

  async function createDivergedRepo(): Promise<string> {
    const repoDir = await createRepoWithUpstream();
    const remoteDir = join(tempDir, "remote.git");
    const peerDir = join(tempDir, "peer");

    await execFileAsync("git", ["clone", remoteDir, peerDir]);
    await runGit(peerDir, ["config", "user.email", "ya-test@example.com"]);
    await runGit(peerDir, ["config", "user.name", "YA Test"]);
    await commitFile(peerDir, "REMOTE.md", "remote\n", "Remote commit");
    await runGit(peerDir, ["push"]);

    await runGit(repoDir, ["fetch", "origin"]);
    await commitFile(repoDir, "LOCAL.md", "local\n", "Local commit");

    return repoDir;
  }

  it("reports up-to-date when push has nothing to send", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/push`, {
      method: "POST",
    });
    const body = (await response.json()) as GitPushResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("up-to-date");
    expect(body.gitStatus?.ahead).toBe(0);
  });

  it("reports pushed when push sends local commits", async () => {
    const repoDir = await createRepoWithUpstream();
    await commitFile(repoDir, "README.md", "hello again\n", "Update readme");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/push`, {
      method: "POST",
    });
    const body = (await response.json()) as GitPushResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("pushed");
    expect(body.gitStatus?.ahead).toBe(0);
  });

  it("reports the last fetch time recorded by git", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);
    const beforeFetchMs = Date.now() - 2_000;

    await runGit(repoDir, ["fetch", "origin"]);

    const afterFetchMs = Date.now() + 2_000;
    const response = await routes.request(`/${projectId}/git`);
    const body = (await response.json()) as GitStatusInfo;
    const checkedRemoteMs = Date.parse(body.checkedRemoteAt ?? "");

    expect(response.status).toBe(200);
    expect(body.checkedRemoteAt).toEqual(expect.any(String));
    expect(Number.isFinite(checkedRemoteMs)).toBe(true);
    expect(checkedRemoteMs).toBeGreaterThanOrEqual(beforeFetchMs);
    expect(checkedRemoteMs).toBeLessThanOrEqual(afterFetchMs);
  });

  it("reports compact untracked folders as dirty entries", async () => {
    const repoDir = await createRepoWithUpstream();
    await mkdir(join(repoDir, "transport", "__tests__"), { recursive: true });
    await writeFile(join(repoDir, "transport", "types.ts"), "export {};\n");
    await writeFile(
      join(repoDir, "transport", "__tests__", "types.test.ts"),
      "export {};\n",
    );
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git`);
    const body = (await response.json()) as GitStatusInfo;

    expect(response.status).toBe(200);
    expect(body.isClean).toBe(false);
    expect(body.files).toContainEqual({
      path: "transport/",
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    });
  });

  it("round-trips non-ASCII untracked folder paths", async () => {
    const repoDir = await createRepoWithUpstream();
    await mkdir(join(repoDir, "fö"), { recursive: true });
    await writeFile(join(repoDir, "fö", "naïve file.txt"), "hello\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const statusResponse = await routes.request(`/${projectId}/git`);
    const statusBody = (await statusResponse.json()) as GitStatusInfo;

    expect(statusResponse.status).toBe(200);
    expect(statusBody.files).toContainEqual({
      path: "fö/",
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    });

    const expandResponse = await routes.request(
      `/${projectId}/git/untracked-folder?path=${encodeURIComponent("fö/")}`,
    );
    const expandBody = (await expandResponse.json()) as GitUntrackedFolderInfo;

    expect(expandResponse.status).toBe(200);
    expect(expandBody).toEqual({
      path: "fö/",
      files: ["fö/naïve file.txt"],
      truncated: false,
      limit: 500,
    });
  });

  it("keeps line counts for non-ASCII changed files", async () => {
    const repoDir = await createRepoWithUpstream();
    await mkdir(join(repoDir, "fö"), { recursive: true });
    await commitFile(repoDir, "fö/naïve file.txt", "hello\n", "Add file");
    await writeFile(join(repoDir, "fö", "naïve file.txt"), "hello\nagain\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git`);
    const body = (await response.json()) as GitStatusInfo;

    expect(response.status).toBe(200);
    expect(body.files).toContainEqual({
      path: "fö/naïve file.txt",
      status: "M",
      staged: false,
      linesAdded: 1,
      linesDeleted: 0,
    });
  });

  it("expands one untracked folder on demand", async () => {
    const repoDir = await createRepoWithUpstream();
    await mkdir(join(repoDir, "transport", "__tests__"), { recursive: true });
    await writeFile(join(repoDir, "transport", "types.ts"), "export {};\n");
    await writeFile(
      join(repoDir, "transport", "__tests__", "types.test.ts"),
      "export {};\n",
    );
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(
      `/${projectId}/git/untracked-folder?path=${encodeURIComponent("transport/")}`,
    );
    const body = (await response.json()) as GitUntrackedFolderInfo;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      path: "transport/",
      files: ["transport/__tests__/types.test.ts", "transport/types.ts"],
      truncated: false,
      limit: 500,
    });
  });

  it("returns a bounded skipped preview for long-line untracked files", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(
      join(repoDir, "large.json"),
      `{"value":"${"x".repeat(30_000)}"}`,
    );
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "large.json",
        staged: false,
        status: "?",
      }),
    });
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(rawBody.length).toBeLessThan(2_000);
    expect(body).toMatchObject({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: {
        reason: "line-too-long",
        maxLineChars: 30_012,
        maxLineCharsLimit: 20_000,
      },
    });
    expect(body.previewSkipped?.totalBytes).toBeGreaterThan(30_000);
  });

  it("skips untracked files over the preview byte budget", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "large.txt"), "line\n".repeat(60_000));
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "large.txt",
        staged: false,
        status: "?",
      }),
    });
    const rawBody = await response.text();
    const body = JSON.parse(rawBody) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(rawBody.length).toBeLessThan(2_000);
    expect(body).toMatchObject({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: {
        reason: "content-too-large",
        maxTotalBytes: 262_144,
        maxLineCharsLimit: 20_000,
      },
    });
    expect(body.previewSkipped?.totalBytes).toBeGreaterThan(262_144);
  });

  it("returns normal git diff previews for small untracked files", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "small.ts"), "export const value = 1;\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "small.ts",
        staged: false,
        status: "?",
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.previewSkipped).toBeUndefined();
    expect(body.diffHtml).toContain("<pre");
    expect(body.structuredPatch).toHaveLength(1);
    expect(body.structuredPatch[0]?.lines).toContain("+export const value = 1;");
  });

  it("can hide whitespace-only working-tree changes", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "README.md"), "hello   \n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "README.md",
        staged: false,
        status: "M",
        ignoreWhitespace: true,
      }),
    });
    const body = (await response.json()) as GitDiffResult;

    expect(response.status).toBe(200);
    expect(body.structuredPatch).toEqual([]);
  });

  it("can diff the current filesystem directly against HEAD", async () => {
    const repoDir = await createRepoWithUpstream();
    await writeFile(join(repoDir, "README.md"), "staged\n");
    await runGit(repoDir, ["add", "README.md"]);
    await writeFile(join(repoDir, "README.md"), "working\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(`/${projectId}/git/diff`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "README.md",
        staged: false,
        status: "M",
        againstHead: true,
      }),
    });
    const body = (await response.json()) as GitDiffResult;
    const lines = body.structuredPatch.flatMap((hunk) => hunk.lines);

    expect(response.status).toBe(200);
    expect(lines).toContain("-hello");
    expect(lines).toContain("+working");
    expect(lines).not.toContain("+staged");
  });

  it("reports automatic integration options for a clean diverged branch", async () => {
    const repoDir = await createDivergedRepo();
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(
      `/${projectId}/git/integration-options`,
    );
    const body = (await response.json()) as GitIntegrationOptionsResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("available");
    expect(body.canAutoRebase).toBe(true);
    expect(body.canAutoMerge).toBe(true);
    expect(body.reasons).toEqual([]);
    expect(body.ahead).toBe(1);
    expect(body.behind).toBe(1);
    expect(body.isClean).toBe(true);
    expect(body.hasSequencerState).toBe(false);
  });

  it("blocks automatic integration options for a dirty diverged branch", async () => {
    const repoDir = await createDivergedRepo();
    await writeFile(join(repoDir, "dirty.txt"), "dirty\n");
    const { projectId, routes } = createRoutesForProject(repoDir);

    const response = await routes.request(
      `/${projectId}/git/integration-options`,
    );
    const body = (await response.json()) as GitIntegrationOptionsResult;

    expect(response.status).toBe(200);
    expect(body.status).toBe("unavailable");
    expect(body.canAutoRebase).toBe(false);
    expect(body.canAutoMerge).toBe(false);
    expect(body.reasons).toContain("dirty-worktree");
    expect(body.ahead).toBe(1);
    expect(body.behind).toBe(1);
    expect(body.isClean).toBe(false);
  });
});
