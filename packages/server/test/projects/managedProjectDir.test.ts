import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureManagedProjectDir } from "../../src/projects/managedProjectDir.js";

const execFileAsync = promisify(execFile);

async function initRepo(dir: string): Promise<void> {
  await execFileAsync("git", ["-C", dir, "init"]);
}

async function readExclude(dir: string): Promise<string> {
  try {
    return await readFile(join(dir, ".git", "info", "exclude"), "utf-8");
  } catch {
    return "";
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

describe("ensureManagedProjectDir", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-managed-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the dir and returns its path", async () => {
    const created = await ensureManagedProjectDir(dir, ".yep");
    expect(created).toBe(join(dir, ".yep"));
    expect(await isDir(created)).toBe(true);
  });

  it("creates nested subPath segments, returning the deepest", async () => {
    const created = await ensureManagedProjectDir(
      dir,
      ".attachments",
      "sess-1",
    );
    expect(created).toBe(join(dir, ".attachments", "sess-1"));
    expect(await isDir(created)).toBe(true);
  });

  it("git-excludes the top-level dir on first creation", async () => {
    await initRepo(dir);
    await ensureManagedProjectDir(dir, ".yep");
    expect(await readExclude(dir)).toContain(".yep/");
  });

  it("excludes only the top-level dir, not the subPath", async () => {
    await initRepo(dir);
    await ensureManagedProjectDir(dir, ".attachments", "sess-1");
    const exclude = await readExclude(dir);
    expect(exclude).toContain(".attachments/");
    expect(exclude).not.toContain("sess-1");
  });

  it("leaves an already-existing dir's exclusion untouched", async () => {
    await initRepo(dir);
    // Pre-create the managed dir: simulates a user who keeps/commits it.
    await mkdir(join(dir, ".yep"), { recursive: true });
    await ensureManagedProjectDir(dir, ".yep");
    expect(await readExclude(dir)).not.toContain(".yep/");
  });

  it("does not duplicate an exclude line if the dir was deleted and recreated", async () => {
    await initRepo(dir);
    await ensureManagedProjectDir(dir, ".yep");
    // Remove the dir but leave the lingering exclude line, then recreate.
    await rm(join(dir, ".yep"), { recursive: true, force: true });
    await ensureManagedProjectDir(dir, ".yep");
    const matches = (await readExclude(dir)).match(/^\.yep\/$/gm) ?? [];
    expect(matches).toHaveLength(1);
  });

  it("still creates the dir outside a git repo (best-effort exclude)", async () => {
    const created = await ensureManagedProjectDir(dir, ".yep");
    expect(await isDir(created)).toBe(true);
  });
});
