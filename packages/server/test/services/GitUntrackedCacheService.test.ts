import { execFile } from "node:child_process";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitUntrackedCacheService } from "../../src/services/GitUntrackedCacheService.js";

const execFileAsync = promisify(execFile);

describe("GitUntrackedCacheService", () => {
  let tempDir: string;
  let projectPath: string;
  let dataDir: string;

  async function git(...args: string[]): Promise<void> {
    await execFileAsync("git", ["-C", projectPath, ...args]);
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ya-untracked-cache-"));
    projectPath = join(tempDir, "project");
    dataDir = join(tempDir, "data");
    await mkdir(projectPath);
    await git("init");
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");
    await writeFile(
      join(projectPath, ".gitignore"),
      "ignored.txt\nignored-dir/\n",
    );
    await writeFile(join(projectPath, "tracked.txt"), "tracked\n");
    await git("add", ".gitignore", "tracked.txt");
    await git("commit", "-m", "initial");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("persists a searchable non-ignored corpus outside the project", async () => {
    const globalExclude = join(tempDir, "global-exclude");
    await writeFile(globalExclude, "global-only.txt\n");
    await git("config", "core.excludesFile", globalExclude);
    await writeFile(
      join(projectPath, ".git", "info", "exclude"),
      "info-only.txt\n",
    );
    await mkdir(join(projectPath, "nested"));
    await mkdir(join(projectPath, "ignored-dir"));
    await writeFile(join(projectPath, "root.txt"), "root\n");
    await writeFile(join(projectPath, "nested", "find-me.txt"), "match\n");
    await writeFile(join(projectPath, "nested", "other.txt"), "other\n");
    await writeFile(join(projectPath, "ignored.txt"), "ignored\n");
    await writeFile(join(projectPath, "ignored-dir", "child.txt"), "ignored\n");
    await writeFile(join(projectPath, "info-only.txt"), "ignored\n");
    await writeFile(join(projectPath, "global-only.txt"), "ignored\n");
    const service = new GitUntrackedCacheService({ dataDir });

    await expect(service.query(projectPath)).resolves.toMatchObject({
      files: ["root.txt"],
      folders: [{ path: "nested/", count: 2 }],
      total: 3,
      truncated: false,
    });
    await expect(
      service.query(projectPath, { q: "FIND-ME" }),
    ).resolves.toMatchObject({
      files: ["nested/find-me.txt"],
      folders: [],
      total: 3,
      truncated: false,
    });
    await expect(
      service.query(projectPath, { path: "nested/" }),
    ).resolves.toMatchObject({
      files: ["nested/find-me.txt", "nested/other.txt"],
      folders: [],
      total: 3,
      truncated: false,
    });

    await expect(lstat(join(projectPath, ".yep"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      readdir(join(dataDir, "indexes", "git-untracked")),
    ).resolves.toHaveLength(1);
  });

  it("drops staged additions and re-adds them after index removal", async () => {
    await mkdir(join(projectPath, "new"));
    await writeFile(join(projectPath, "new", "staged.txt"), "new\n");
    const service = new GitUntrackedCacheService({
      dataDir,
      fullRefreshIntervalMs: 24 * 60 * 60 * 1000,
    });

    expect((await service.query(projectPath, { path: "new/" })).files).toEqual([
      "new/staged.txt",
    ]);

    await git("add", "new/staged.txt");
    expect((await service.query(projectPath, { path: "new/" })).files).toEqual(
      [],
    );

    await git("reset", "--", "new/staged.txt");
    expect((await service.query(projectPath, { path: "new/" })).files).toEqual([
      "new/staged.txt",
    ]);
  });

  it("reuses persisted candidates without walking for every query", async () => {
    await writeFile(join(projectPath, "cached.txt"), "cached\n");
    const options = {
      dataDir,
      fullRefreshIntervalMs: 24 * 60 * 60 * 1000,
    };
    const first = new GitUntrackedCacheService(options);
    expect((await first.query(projectPath)).files).toContain("cached.txt");

    await writeFile(join(projectPath, "not-yet-reconciled.txt"), "later\n");
    const reopened = new GitUntrackedCacheService(options);
    expect((await reopened.query(projectPath, { q: "not-yet" })).files).toEqual(
      [],
    );
    expect((await reopened.query(projectPath, { q: "cached" })).files).toEqual([
      "cached.txt",
    ]);
  });

  it("keeps HEAD paths out after the index stops tracking them", async () => {
    const service = new GitUntrackedCacheService({ dataDir });
    await service.query(projectPath);

    await git("rm", "--cached", "tracked.txt");

    expect(
      (await service.query(projectPath, { q: "tracked.txt" })).files,
    ).toEqual([]);
  });

  it("rechecks selected stale paths no more than hourly", async () => {
    let now = 1_000_000;
    await writeFile(join(projectPath, "stale.txt"), "stale\n");
    const service = new GitUntrackedCacheService({
      dataDir,
      now: () => now,
      fullRefreshIntervalMs: 24 * 60 * 60 * 1000,
      fileRecheckIntervalMs: 60 * 60 * 1000,
    });
    expect((await service.query(projectPath, { q: "stale" })).files).toEqual([
      "stale.txt",
    ]);

    await unlink(join(projectPath, "stale.txt"));
    now += 60 * 60 * 1000 - 1;
    expect((await service.query(projectPath, { q: "stale" })).files).toEqual([
      "stale.txt",
    ]);

    now += 1;
    expect((await service.query(projectPath, { q: "stale" })).files).toEqual(
      [],
    );
  });

  it("rechecks stale nested paths only when their folder is selected", async () => {
    let now = 1_000_000;
    await mkdir(join(projectPath, "nested"));
    await writeFile(join(projectPath, "nested", "stale.txt"), "stale\n");
    const service = new GitUntrackedCacheService({
      dataDir,
      now: () => now,
      fullRefreshIntervalMs: 24 * 60 * 60 * 1000,
      fileRecheckIntervalMs: 60 * 60 * 1000,
    });
    expect((await service.query(projectPath)).folders).toEqual([
      { path: "nested/", count: 1 },
    ]);

    await unlink(join(projectPath, "nested", "stale.txt"));
    now += 60 * 60 * 1000;
    expect((await service.query(projectPath)).folders).toEqual([
      { path: "nested/", count: 1 },
    ]);
    expect(
      (await service.query(projectPath, { path: "nested/" })).files,
    ).toEqual([]);
  });

  it("rejects persisted paths that escape the project", async () => {
    await writeFile(join(tempDir, "outside.txt"), "outside\n");
    const options = {
      dataDir,
      fullRefreshIntervalMs: 24 * 60 * 60 * 1000,
      fileRecheckIntervalMs: 60 * 60 * 1000,
    };
    const first = new GitUntrackedCacheService(options);
    await first.query(projectPath);
    const [cacheName] = await readdir(
      join(dataDir, "indexes", "git-untracked"),
    );
    if (!cacheName) throw new Error("Persisted cache was not created");
    const cachePath = join(dataDir, "indexes", "git-untracked", cacheName);
    const persisted = JSON.parse(await readFile(cachePath, "utf8")) as Record<
      string,
      unknown
    >;
    persisted.files = ["../outside.txt"];
    persisted.checkedAt = { "../outside.txt": 0 };
    await writeFile(cachePath, `${JSON.stringify(persisted)}\n`);

    const reopened = new GitUntrackedCacheService(options);
    expect((await reopened.query(projectPath, { q: "outside" })).files).toEqual(
      [],
    );
  });

  it("reports cache and response safety bounds honestly", async () => {
    await writeFile(join(projectPath, "a.txt"), "a\n");
    await writeFile(join(projectPath, "b.txt"), "b\n");
    await writeFile(join(projectPath, "c.txt"), "c\n");
    const service = new GitUntrackedCacheService({
      dataDir,
      cacheFileLimit: 2,
      responseLimit: 1,
    });

    const result = await service.query(projectPath);
    expect(result.files).toHaveLength(1);
    expect(result.total).toBe(2);
    expect(result.limit).toBe(1);
    expect(result.truncated).toBe(true);
  });
});
