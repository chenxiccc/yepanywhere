import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  type GitUntrackedFileListResult,
  type GitWorkingTreeFileListResult,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGitWorkingTreeFilesRoutes } from "../../src/routes/git-working-tree-files.js";
import type { Project } from "../../src/supervisor/types.js";

const execFileAsync = promisify(execFile);

function createRoutesForProject(projectPath: string, dataDir: string) {
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
    routes: createGitWorkingTreeFilesRoutes({
      scanner: {
        async getProject(id: string) {
          return id === projectId ? project : null;
        },
      } as unknown as ProjectScanner,
      dataDir,
    }),
  };
}

describe("git-working-tree-files routes", () => {
  let dir: string;
  let dataDir: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
    return stdout.trim();
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-working-tree-files-"));
    dataDir = await mkdtemp(join(tmpdir(), "yep-working-tree-data-"));
    await git("init");
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");
    await writeFile(join(dir, ".gitignore"), "ignored.txt\n");
    await writeFile(join(dir, "clean.ts"), "clean\n");
    await writeFile(join(dir, "deleted.ts"), "deleted\n");
    await git("add", ".gitignore", "clean.ts", "deleted.ts");
    await git("commit", "-m", "initial");
  });

  afterEach(async () => {
    await Promise.all([
      rm(dir, { recursive: true, force: true }),
      rm(dataDir, { recursive: true, force: true }),
    ]);
  });

  it("lists present tracked and untracked files without ignored or deleted paths", async () => {
    await writeFile(join(dir, "indexed-add.ts"), "indexed\n");
    await git("add", "indexed-add.ts");
    await writeFile(join(dir, "untracked.txt"), "untracked\n");
    await writeFile(join(dir, "雪.txt"), "unicode\n");
    await writeFile(join(dir, "ignored.txt"), "ignored\n");
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "new.txt"), "nested\n");
    await unlink(join(dir, "deleted.ts"));
    const { projectId, routes } = createRoutesForProject(dir, dataDir);

    const response = await routes.request(
      `/${projectId}/git/working-tree-files`,
    );
    const body = (await response.json()) as GitWorkingTreeFileListResult;

    expect(response.status).toBe(200);
    expect(body).toEqual({
      files: [
        { path: ".gitignore", tracked: true, kind: "tracked" },
        { path: "clean.ts", tracked: true, kind: "tracked" },
        { path: "indexed-add.ts", tracked: true, kind: "tracked" },
        { path: "nested/new.txt", tracked: false, kind: "untracked" },
        { path: "untracked.txt", tracked: false, kind: "untracked" },
        { path: "雪.txt", tracked: false, kind: "untracked" },
      ],
      truncated: false,
      limit: 50_000,
    });
  });

  it("enumerates ignored paths only when their section is enabled", async () => {
    await writeFile(join(dir, "untracked.txt"), "untracked\n");
    await writeFile(join(dir, "ignored.txt"), "ignored\n");
    await writeFile(join(dir, ".git", "administrative.txt"), "hidden\n");
    const { projectId, routes } = createRoutesForProject(dir, dataDir);

    const response = await routes.request(
      `/${projectId}/git/working-tree-files?tracked=false&untracked=false&ignored=true`,
    );
    const body = (await response.json()) as GitWorkingTreeFileListResult;

    expect(response.status).toBe(200);
    expect(body.files).toEqual([
      { path: "ignored.txt", tracked: false, kind: "ignored" },
    ]);
  });

  it("searches cached children before a folder is expanded", async () => {
    await mkdir(join(dir, "nested"));
    await writeFile(join(dir, "nested", "find-me.txt"), "match\n");
    await writeFile(join(dir, "nested", "other.txt"), "other\n");
    const { projectId, routes } = createRoutesForProject(dir, dataDir);

    const rootResponse = await routes.request(
      `/${projectId}/git/untracked-files`,
    );
    const root = (await rootResponse.json()) as GitUntrackedFileListResult;
    expect(rootResponse.status).toBe(200);
    expect(root.folders).toEqual([{ path: "nested/", count: 2 }]);

    const searchResponse = await routes.request(
      `/${projectId}/git/untracked-files?q=find-me`,
    );
    const search = (await searchResponse.json()) as GitUntrackedFileListResult;
    expect(searchResponse.status).toBe(200);
    expect(search.files).toEqual(["nested/find-me.txt"]);

    const dotPath = await routes.request(
      `/${projectId}/git/untracked-files?path=nested%2F.%2F`,
    );
    expect(dotPath.status).toBe(400);
  });

  it("reports truncation at the requested safety bound", async () => {
    await writeFile(join(dir, "another.ts"), "another\n");
    const { projectId, routes } = createRoutesForProject(dir, dataDir);

    const response = await routes.request(
      `/${projectId}/git/working-tree-files?limit=2`,
    );
    const body = (await response.json()) as GitWorkingTreeFileListResult;

    expect(response.status).toBe(200);
    expect(body.files).toHaveLength(2);
    expect(body.truncated).toBe(true);
    expect(body.limit).toBe(2);
  });
});
