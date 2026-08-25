import { execFile } from "node:child_process";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type GitFileRevision, toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitFileRevisionRoutes } from "../../src/routes/git-file-revision.js";
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
    routes: createGitFileRevisionRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
    }),
  };
}

describe("git file revision routes", () => {
  let dir: string;
  let fileCommit: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
    return stdout.trim();
  }

  async function request(
    path: string,
    params: Record<string, string> = {},
  ): Promise<{ body: GitFileRevision; status: number }> {
    const { projectId, routes } = createRoutesForProject(dir);
    const query = new URLSearchParams({ path, ...params });
    const response = await routes.request(
      `/${projectId}/git/file-revision?${query.toString()}`,
    );
    return {
      body: (await response.json()) as GitFileRevision,
      status: response.status,
    };
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-git-file-revision-"));
    await git("init");
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");
    await writeFile(join(dir, "file.txt"), "committed\n");
    await git("add", "file.txt");
    await git("commit", "-m", "add file");
    fileCommit = await git("rev-parse", "HEAD");
    await writeFile(join(dir, "other.txt"), "later\n");
    await git("add", "other.txt");
    await git("commit", "-m", "touch another file");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the last commit that touched clean live content", async () => {
    const { body, status } = await request("file.txt");

    expect(status).toBe(200);
    expect(body.isGitRepo).toBe(true);
    expect(body.commit).toMatchObject({
      hash: fileCommit,
      authorName: "YA Test",
      subject: "add file",
      message: "add file",
      messageTruncated: false,
    });
    expect(body.dirty).toBe(false);
  });

  it("marks live content dirty only when its bytes differ", async () => {
    await writeFile(join(dir, "file.txt"), "changed\n");
    expect((await request("file.txt")).body.dirty).toBe(true);

    await writeFile(join(dir, "file.txt"), "committed\n");
    expect((await request("file.txt")).body.dirty).toBe(false);
  });

  it("follows an uncommitted rename without treating the path as content", async () => {
    await rename(join(dir, "file.txt"), join(dir, "renamed.txt"));
    const { body } = await request("renamed.txt", { origPath: "file.txt" });

    expect(body.commit?.hash).toBe(fileCommit);
    expect(body.dirty).toBe(false);
  });

  it("keeps immutable revision views clean", async () => {
    await writeFile(join(dir, "file.txt"), "changed\n");
    const { body } = await request("file.txt", { rev: fileCommit });

    expect(body.commit?.hash).toBe(fileCommit);
    expect(body.dirty).toBe(false);
  });

  it("caps tooltip messages at 50 lines", async () => {
    const messagePath = join(dir, ".commit-message");
    await writeFile(join(dir, "file.txt"), "new revision\n");
    await writeFile(
      messagePath,
      `${Array.from({ length: 55 }, (_, index) => `line ${index + 1}`).join("\n")}\n`,
    );
    await git("add", "file.txt");
    await git("commit", "-F", messagePath);
    await rm(messagePath);

    const { body } = await request("file.txt");
    expect(body.commit?.message.split("\n")).toHaveLength(50);
    expect(body.commit?.message).toContain("line 50");
    expect(body.commit?.message).not.toContain("line 51");
    expect(body.commit?.messageTruncated).toBe(true);
  });

  it("does not invent provenance for an untracked file", async () => {
    await writeFile(join(dir, "new.txt"), "untracked\n");
    const { body } = await request("new.txt");

    expect(body.commit).toBeNull();
    expect(body.dirty).toBe(false);
  });
});
