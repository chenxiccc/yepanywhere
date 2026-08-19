import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanGitWorktree } from "../../src/projects/projectWorktreeSubscriptionManager.js";

const execFileAsync = promisify(execFile);

async function runGit(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

async function commit(repo: string, message: string): Promise<void> {
  await runGit(repo, ["add", "--all"]);
  await runGit(repo, ["commit", "-m", message]);
}

describe("scanGitWorktree", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), "ya-worktree-scan-"));
    await runGit(repo, ["init"]);
    await runGit(repo, ["config", "user.email", "ya-test@example.com"]);
    await runGit(repo, ["config", "user.name", "YA Test"]);
    await writeFile(join(repo, "README.md"), "initial\n");
    await writeFile(join(repo, "delete-me.txt"), "delete me\n");
    await commit(repo, "Initial files");
    await writeFile(join(repo, ".gitignore"), "build/\n");
    await writeFile(join(repo, "committed.ts"), "export const value = 1;\n");
    await commit(repo, "Add committed change");
  });

  afterEach(async () => {
    await rm(repo, { recursive: true });
  });

  it("combines tracked dirty, cumulative, deleted, and untracked truth", async () => {
    await writeFile(join(repo, "README.md"), "staged\n");
    await runGit(repo, ["add", "README.md"]);
    await writeFile(join(repo, "README.md"), "unstaged after staged\n");
    await rm(join(repo, "delete-me.txt"));
    await writeFile(join(repo, "untracked.txt"), "new\n");
    await mkdir(join(repo, "build"));
    await writeFile(join(repo, "build", "ignored.txt"), "ignored\n");

    const ordinary = await scanGitWorktree(repo, {
      tracked: true,
      untracked: true,
      ignored: false,
    });

    expect(ordinary.headSha).toMatch(/^[0-9a-f]{40}$/);
    expect(ordinary.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(ordinary.files.get("README.md")).toMatchObject({
      tracked: true,
      present: true,
      worktreeChanges: [
        { status: "M", staged: true },
        { status: "M", staged: false },
      ],
      cumulativeChange: { status: "M" },
    });
    expect(ordinary.files.get("committed.ts")).toMatchObject({
      tracked: true,
      present: true,
      cumulativeChange: { status: "A" },
    });
    expect(ordinary.files.get("delete-me.txt")).toMatchObject({
      tracked: true,
      present: false,
      worktreeChanges: [{ status: "D", staged: false }],
      cumulativeChange: { status: "D" },
    });
    expect(ordinary.files.get("untracked.txt")).toMatchObject({
      tracked: false,
      kind: "untracked",
      present: true,
      worktreeChanges: [{ status: "?" }],
      cumulativeChange: { status: "?" },
    });
    expect(ordinary.files.has("build/ignored.txt")).toBe(false);
    expect(ordinary.files.has(".git/config")).toBe(false);

    const withIgnored = await scanGitWorktree(repo, {
      tracked: true,
      untracked: true,
      ignored: true,
    });
    expect(withIgnored.files.get("build/ignored.txt")).toMatchObject({
      tracked: false,
      kind: "ignored",
      present: true,
    });
    expect(withIgnored.files.has(".git/config")).toBe(false);
  });
});
