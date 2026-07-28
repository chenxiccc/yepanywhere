import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  blameCacheStatsForTest,
  getBlame,
  insertBlameCacheEntryForTest,
  resetBlameCacheForTest,
} from "../../src/git/blame.js";

const execFileAsync = promisify(execFile);

describe("blame LRU cache", () => {
  let dir: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
    return stdout.trim();
  }

  beforeEach(async () => {
    resetBlameCacheForTest();
    dir = await mkdtemp(join(tmpdir(), "ya-blame-cache-"));
    await execFileAsync("git", ["init", dir]);
    await git("config", "user.email", "t@example.com");
    await git("config", "user.name", "t");
    await writeFile(join(dir, "a.ts"), "const one = 1;\n");
    await git("add", "-A");
    await git("commit", "-m", "one");
  });

  afterEach(async () => {
    resetBlameCacheForTest();
    await rm(dir, { recursive: true, force: true });
  });

  it("serves an unchanged working-tree revisit from cache", async () => {
    const first = await getBlame(dir, "a.ts", undefined);
    const hitsBefore = blameCacheStatsForTest().hits;
    const second = await getBlame(dir, "a.ts", undefined);
    expect(blameCacheStatsForTest().hits).toBe(hitsBefore + 1);
    expect(second).toEqual(first);
  });

  it("a file edit invalidates the working-tree entry", async () => {
    await getBlame(dir, "a.ts", undefined);
    await writeFile(join(dir, "a.ts"), "const one = 1;\nconst two = 2;\n");
    const hitsBefore = blameCacheStatsForTest().hits;
    const res = await getBlame(dir, "a.ts", undefined);
    expect(blameCacheStatsForTest().hits).toBe(hitsBefore);
    expect(res.lines).toHaveLength(2);
    expect(res.lines[1]?.uncommitted).toBe(true);
  });

  it("a new commit invalidates even when the file is untouched", async () => {
    await writeFile(join(dir, "a.ts"), "const one = 1;\nconst two = 2;\n");
    const before = await getBlame(dir, "a.ts", undefined);
    expect(before.lines[1]?.uncommitted).toBe(true);
    // Committing rewrites history but not the worktree file: only the HEAD
    // component of the validator changes.
    await git("add", "-A");
    await git("commit", "-m", "two");
    const after = await getBlame(dir, "a.ts", undefined);
    expect(after.lines[1]?.uncommitted).toBe(false);
  });

  it("caches an explicit commit immutably, short sha sharing the key", async () => {
    const sha = await git("rev-parse", "HEAD");
    const first = await getBlame(dir, "a.ts", sha);
    const hitsBefore = blameCacheStatsForTest().hits;
    const second = await getBlame(dir, "a.ts", sha.slice(0, 8));
    expect(blameCacheStatsForTest().hits).toBe(hitsBefore + 1);
    expect(second).toEqual(first);
    expect(blameCacheStatsForTest().bytes).toBeGreaterThan(0);
  });

  it("accounts for only the winning entry when concurrent misses replace a key", () => {
    insertBlameCacheEntryForTest("same-key", 80);
    insertBlameCacheEntryForTest("same-key", 120);

    expect(blameCacheStatsForTest()).toMatchObject({
      entries: 1,
      bytes: 120,
    });
  });
});
