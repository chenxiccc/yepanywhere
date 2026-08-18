import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitIncomingCommitListResult,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitIncomingCommitsRoutes } from "../../src/routes/git-incoming-commits.js";
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
    routes: createGitIncomingCommitsRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
    }),
  };
}

describe("git-incoming-commits routes", () => {
  let dir: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
    return stdout.trim();
  }

  async function commit(message: string, content: string): Promise<string> {
    await writeFile(join(dir, "file.txt"), content);
    await git("add", "file.txt");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-incoming-commits-"));
    await git("init");
    await git("remote", "add", "origin", dir);
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");
    await git("branch", "-M", "main");
    await commit("local base", "base\n");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("lists the last-fetched upstream commits without changing refs", async () => {
    const localHead = await git("rev-parse", "HEAD");
    await git("checkout", "-b", "remote-tip");
    const firstIncoming = await commit("incoming one", "one\n");
    const upstreamTip = await commit("incoming two", "two\n");
    await git("update-ref", "refs/remotes/origin/main", upstreamTip);
    await git("checkout", "main");
    await git("config", "branch.main.remote", "origin");
    await git("config", "branch.main.merge", "refs/heads/main");
    const { projectId, routes } = createRoutesForProject(dir);

    const response = await routes.request(`/${projectId}/git/incoming-commits`);
    const body = (await response.json()) as GitIncomingCommitListResult;

    expect(response.status).toBe(200);
    expect(body.upstream).toBe("origin/main");
    expect(body.headSha).toBe(localHead);
    expect(body.upstreamSha).toBe(upstreamTip);
    expect(body.commits.map((item) => item.hash)).toEqual([
      upstreamTip,
      firstIncoming,
    ]);
    expect(body.commits.map((item) => item.subject)).toEqual([
      "incoming two",
      "incoming one",
    ]);
    expect(body.truncated).toBe(false);
    expect(await git("rev-parse", "refs/remotes/origin/main")).toBe(
      upstreamTip,
    );
  });

  it("reports bounds and a missing upstream", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    const missing = await routes.request(`/${projectId}/git/incoming-commits`);
    expect(missing.status).toBe(404);

    await git("checkout", "-b", "remote-tip");
    await commit("incoming one", "one\n");
    const upstreamTip = await commit("incoming two", "two\n");
    await git("update-ref", "refs/remotes/origin/main", upstreamTip);
    await git("checkout", "main");
    await git("config", "branch.main.remote", "origin");
    await git("config", "branch.main.merge", "refs/heads/main");

    const bounded = await routes.request(
      `/${projectId}/git/incoming-commits?limit=1`,
    );
    const body = (await bounded.json()) as GitIncomingCommitListResult;
    expect(body.commits).toHaveLength(1);
    expect(body.truncated).toBe(true);
    expect(body.limit).toBe(1);
  });

  it("preserves unexpected Git failures as server errors", async () => {
    const { projectId, routes } = createRoutesForProject(dir);
    await rm(join(dir, ".git"), { recursive: true });

    const response = await routes.request(`/${projectId}/git/incoming-commits`);

    expect(response.status).toBe(500);
  });
});
