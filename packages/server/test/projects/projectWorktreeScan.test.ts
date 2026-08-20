import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGitMetadata } from "../../src/projects/projectWorktreeSubscriptionManager.js";
import {
  scanFilesystemWorktree,
  scanGitWorktree,
} from "../../src/projects/projectWorktreeScan.js";

const fsReadFailure = vi.hoisted(() => ({
  typedDirectory: null as string | null,
}));
vi.mock("node:fs/promises", async () => {
  const actual =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  const actualReaddir = actual.readdir as unknown as (
    ...args: unknown[]
  ) => unknown;
  return {
    ...actual,
    readdir: (...args: unknown[]) => {
      const options = args[1];
      if (
        String(args[0]) === fsReadFailure.typedDirectory &&
        options !== null &&
        typeof options === "object" &&
        "withFileTypes" in options &&
        options.withFileTypes === true
      ) {
        return Promise.reject(
          Object.assign(new Error("typed read failed"), { code: "EIO" }),
        );
      }
      return actualReaddir(...args);
    },
  };
});

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
    fsReadFailure.typedDirectory = null;
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

  it("lists a bounded filesystem-only working tree without Git metadata", async () => {
    await mkdir(join(repo, "notes", "nested"), { recursive: true });
    await writeFile(join(repo, "notes", "nested", "idea.txt"), "idea\n");

    const scan = await scanFilesystemWorktree(
      repo,
      { tracked: true, untracked: true, ignored: true },
      100,
    );

    expect(scan.files.get("notes/nested/idea.txt")).toMatchObject({
      tracked: false,
      kind: "untracked",
      present: true,
      worktreeChanges: [{ status: "?", staged: false }],
    });
    expect(
      [...scan.files.keys()].some((path) => path.startsWith(".git/")),
    ).toBe(false);
    expect(scan.truncated).toBe(false);

    const bounded = await scanFilesystemWorktree(
      repo,
      { tracked: true, untracked: true, ignored: true },
      1,
    );
    expect(bounded.files.size).toBe(1);
    expect(bounded.truncated).toBe(true);

    const withoutUntracked = await scanFilesystemWorktree(
      repo,
      { tracked: true, untracked: false, ignored: true },
      100,
    );
    expect(withoutUntracked.files.size).toBe(0);
  });

  it("enumerates only root and explicitly opened filesystem directories", async () => {
    await mkdir(join(repo, "notes", "nested"), { recursive: true });
    await writeFile(join(repo, "notes", "direct.txt"), "direct\n");
    await writeFile(join(repo, "notes", "nested", "idea.txt"), "idea\n");

    const rootOnly = await scanFilesystemWorktree(
      repo,
      {
        tracked: true,
        untracked: true,
        ignored: true,
        expandedPrefixes: [],
      },
      100,
    );

    expect(rootOnly.files.has("notes/direct.txt")).toBe(false);
    expect(rootOnly.directories).toEqual(new Set([""]));
    expect(rootOnly.directoryRows?.get("notes")).toEqual({
      path: "notes",
      pending: true,
      truncated: false,
    });

    const opened = await scanFilesystemWorktree(
      repo,
      {
        tracked: true,
        untracked: true,
        ignored: true,
        expandedPrefixes: ["notes"],
      },
      100,
    );

    expect(opened.files.get("notes/direct.txt")).toMatchObject({
      tracked: false,
      kind: "untracked",
      present: true,
    });
    expect(opened.files.has("notes/nested/idea.txt")).toBe(false);
    expect(opened.directories).toEqual(new Set(["", "notes"]));
    expect(opened.directoryRows?.get("notes")).toEqual({
      path: "notes",
      pending: false,
      truncated: false,
      totalFiles: 1,
    });
    expect(opened.totalFiles).toBe(opened.files.size);
    expect(opened.directoryRows?.get("notes/nested")).toEqual({
      path: "notes/nested",
      pending: true,
      truncated: false,
    });
  });

  it("reports an exact total when row enumeration fails after a count-only read", async () => {
    await mkdir(join(repo, "blocked"));
    await writeFile(join(repo, "blocked", "a.txt"), "a\n");
    await writeFile(join(repo, "blocked", "b.txt"), "b\n");
    fsReadFailure.typedDirectory = join(repo, "blocked");

    const scan = await scanFilesystemWorktree(
      repo,
      {
        tracked: true,
        untracked: true,
        ignored: true,
        expandedPrefixes: ["blocked"],
      },
      100,
    );

    expect(scan.files.has("blocked/a.txt")).toBe(false);
    expect(scan.files.has("blocked/b.txt")).toBe(false);
    expect(scan.directoryRows?.get("blocked")).toEqual({
      path: "blocked",
      pending: false,
      truncated: true,
      totalFiles: 2,
    });
    expect(scan.totalFiles).toBe(scan.files.size + 2);
    expect(scan.truncated).toBe(true);
  });

  it("does not enumerate a requested symlink as an opened directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ya-worktree-outside-"));
    try {
      await writeFile(join(outside, "secret.txt"), "secret\n");
      await symlink(outside, join(repo, "outside"));

      const scan = await scanFilesystemWorktree(
        repo,
        {
          tracked: true,
          untracked: true,
          ignored: true,
          expandedPrefixes: ["outside"],
        },
        100,
      );

      expect(scan.files.has("outside/secret.txt")).toBe(false);
      expect(scan.directories).toEqual(new Set([""]));
      expect(scan.directoryRows?.has("outside")).toBe(false);
    } finally {
      await rm(outside, { recursive: true });
    }
  });

  it("enumerates every direct file in an opened filesystem directory", async () => {
    await mkdir(join(repo, "many", "nested"), { recursive: true });
    await writeFile(join(repo, "many", "a.txt"), "a\n");
    await writeFile(join(repo, "many", "b.txt"), "b\n");

    const scan = await scanFilesystemWorktree(
      repo,
      {
        tracked: true,
        untracked: true,
        ignored: true,
        expandedPrefixes: ["many"],
      },
      1,
    );

    expect(
      [...scan.files.keys()].filter((path) => path.startsWith("many/")),
    ).toEqual(["many/a.txt", "many/b.txt"]);
    expect(scan.directoryRows?.get("many")).toEqual({
      path: "many",
      pending: false,
      truncated: false,
      totalFiles: 2,
    });
    expect(scan.directoryRows?.get("many/nested")).toEqual({
      path: "many/nested",
      pending: true,
      truncated: false,
    });
    expect(scan.totalFiles).toBe(scan.files.size);
  });

  it("resolves separate per-worktree and common Git directories", async () => {
    const linked = `${repo}-linked`;
    try {
      await runGit(repo, ["worktree", "add", "-b", "ya-linked", linked]);
      const metadata = await resolveGitMetadata(linked);

      expect(metadata).not.toBeNull();
      expect(metadata?.gitDir).not.toBe(metadata?.commonDir);
      expect(metadata?.commonDir).toBe(join(repo, ".git"));
      expect(metadata?.headRefPath).toBe(
        join(repo, ".git", "refs", "heads", "ya-linked"),
      );

      await runGit(linked, ["switch", "--detach"]);
      expect((await resolveGitMetadata(linked))?.headRefPath).toBeNull();
    } finally {
      await rm(linked, { recursive: true });
    }
  });
});
