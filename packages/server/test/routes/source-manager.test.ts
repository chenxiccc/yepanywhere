import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createSourceManagerRoutes } from "../../src/routes/source-manager.js";
import type { Project } from "../../src/supervisor/types.js";

const execFileAsync = promisify(execFile);

// 临时 git 仓库辅助函数 / Helpers for temporary git repos
async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
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
    routes: createSourceManagerRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
    }),
  };
}

// 解析 GET /git 响应 / Parse GET /git response
type StatusBody = {
  isGitRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  isClean: boolean;
  files: { path: string; status: string }[];
  latestLocalCommit?: { message?: string } | null;
};

// 解析 GET /git/branches 响应 / Parse GET /git/branches response
type BranchesBody = {
  branches: {
    name: string;
    current: boolean;
    remote: boolean;
  }[];
};

describe("source-manager routes caching", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "yep-source-manager-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  // 建一个带 origin 上游的仓库（保证有 upstream/defaultRemote，命中缓存路径）
  // Build a repo with an origin upstream (so upstream/defaultRemote exist, exercising cache paths)
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

  it("returns fresh status after commit (write invalidates cache)", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);

    // 制造一个未提交改动（修改已跟踪文件）/ Make an uncommitted change (modify tracked file)
    await writeFile(join(repoDir, "README.md"), "hello again\n");

    // 首次 GET /git：有未提交改动，isClean=false / First GET /git: uncommitted change, isClean=false
    const before = await routes.request(`/${projectId}/git`, { method: "GET" });
    const beforeBody = (await before.json()) as StatusBody;
    expect(before.status).toBe(200);
    expect(beforeBody.isClean).toBe(false);
    expect(beforeBody.files.length).toBeGreaterThan(0);

    // 写端点 commit 后服务端失效 status 缓存，GET /git 必须返回新鲜值（isClean=true）
    // After commit, server invalidates status cache; GET /git must return fresh (isClean=true)
    const commitRes = await routes.request(`/${projectId}/git/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Update readme",
        selectedPaths: ["README.md"],
      }),
    });
    expect(commitRes.status).toBe(200);

    const after = await routes.request(`/${projectId}/git`, { method: "GET" });
    const afterBody = (await after.json()) as StatusBody;
    expect(after.status).toBe(200);
    // 关键断言：写后 GET 返回新鲜值，不是旧缓存（isClean 从 false 变 true）
    // Key assertion: post-write GET returns fresh value, not stale cache (isClean false -> true)
    expect(afterBody.isClean).toBe(true);
    expect(afterBody.files.length).toBe(0);
  });

  it("updates current branch marker in GET /branches after switch", async () => {
    const repoDir = await createRepoWithUpstream();
    // 额外建一个分支 feature（不切换），当前仍在 main/master
    // Create a feature branch without switching; still on main/master
    await runGit(repoDir, ["branch", "feature"]);
    const { projectId, routes } = createRoutesForProject(repoDir);

    // 切换到 feature / Switch to feature
    const switchRes = await routes.request(
      `/${projectId}/git/switch-branch`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetBranch: "feature" }),
      },
    );
    expect(switchRes.status).toBe(200);

    // switch 后服务端失效 branches 缓存，GET /branches 必须把 feature 标为 current
    // After switch, server invalidates branches cache; GET /branches must mark feature current
    const branchesRes = await routes.request(
      `/${projectId}/git/branches`,
      { method: "GET" },
    );
    const branchesBody = (await branchesRes.json()) as BranchesBody;
    expect(branchesRes.status).toBe(200);
    const feature = branchesBody.branches.find((b) => b.name === "feature");
    expect(feature).toBeDefined();
    expect(feature?.current).toBe(true);
  });

  it("dedups concurrent GET /git requests without deadlocking", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);

    // 并发两个 GET /git：inFlight 去重应复用同一请求，两者都成功返回
    // Two concurrent GET /git: in-flight dedup reuses one request; both succeed
    const [a, b] = await Promise.all([
      routes.request(`/${projectId}/git`, { method: "GET" }),
      routes.request(`/${projectId}/git`, { method: "GET" }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const aBody = (await a.json()) as StatusBody;
    const bBody = (await b.json()) as StatusBody;
    expect(aBody.branch).toBe(bBody.branch);
    expect(aBody.ahead).toBe(bBody.ahead);
  });

  it("returns consistent status across repeated GET /git (cache hit)", async () => {
    const repoDir = await createRepoWithUpstream();
    const { projectId, routes } = createRoutesForProject(repoDir);

    const first = await routes.request(`/${projectId}/git`, {
      method: "GET",
    });
    const firstBody = (await first.json()) as StatusBody;

    // 第二次 GET 命中缓存，返回值与第一次一致 / Second GET hits cache, returns same value
    const second = await routes.request(`/${projectId}/git`, {
      method: "GET",
    });
    const secondBody = (await second.json()) as StatusBody;

    expect(second.status).toBe(200);
    expect(secondBody.branch).toBe(firstBody.branch);
    expect(secondBody.ahead).toBe(firstBody.ahead);
    expect(secondBody.files.length).toBe(firstBody.files.length);
  });
});
