import type { Dirent } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readdir = vi.fn();

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readdir,
}));

const { scanFilesystemWorktree } = await import(
  "../../src/projects/projectWorktreeScan.js"
);

const ALL_COVERAGE = { tracked: true, untracked: true, ignored: true };

function directory(name: string): Dirent {
  return { name, isDirectory: () => true } as unknown as Dirent;
}

function file(name: string): Dirent {
  return { name, isDirectory: () => false } as unknown as Dirent;
}

function failure(code: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(code);
  error.code = code;
  return error;
}

/**
 * A live worktree changes under a walk, and some of it may not be readable at
 * all. Neither ends the walk; only the file limit does.
 */
describe("scanFilesystemWorktree directory failures", () => {
  beforeEach(() => {
    readdir.mockReset();
  });

  it("skips a directory removed under the walk without reporting truncation", async () => {
    readdir.mockImplementation(async (path: string) => {
      if (path === "/project") return [directory("gone"), directory("kept")];
      if (path === "/project/gone") throw failure("ENOENT");
      if (path === "/project/kept") return [file("stays.txt")];
      throw failure("ENOENT");
    });

    const scan = await scanFilesystemWorktree("/project", ALL_COVERAGE, 100);

    expect([...scan.files.keys()]).toEqual(["kept/stays.txt"]);
    expect(scan.truncated).toBe(false);
  });

  it("spends its budget breadth first and watches only what it read", async () => {
    // A heavy dependency tree must not crowd out the shallow files a reader
    // came for, and directories the walk never reached are not watch targets.
    readdir.mockImplementation(async (path: string) => {
      if (path === "/project") {
        return [directory("deps"), file("root.txt")];
      }
      if (path === "/project/deps") {
        return [directory("deep"), file("a.txt"), file("b.txt")];
      }
      if (path === "/project/deps/deep") return [file("buried.txt")];
      throw failure("ENOENT");
    });

    const scan = await scanFilesystemWorktree("/project", ALL_COVERAGE, 2);

    expect([...scan.files.keys()]).toEqual(["root.txt", "deps/a.txt"]);
    expect(scan.truncated).toBe(true);
    expect([...(scan.directories ?? [])].sort()).toEqual(["", "deps"]);
  });

  it("names every directory it read when the walk completes", async () => {
    readdir.mockImplementation(async (path: string) => {
      if (path === "/project") return [directory("src"), file("root.txt")];
      if (path === "/project/src") return [file("main.ts")];
      throw failure("ENOENT");
    });

    const scan = await scanFilesystemWorktree("/project", ALL_COVERAGE, 100);

    expect(scan.truncated).toBe(false);
    expect([...(scan.directories ?? [])].sort()).toEqual(["", "src"]);
  });

  it("reports an incomplete inventory when a directory cannot be read", async () => {
    readdir.mockImplementation(async (path: string) => {
      if (path === "/project") return [directory("closed"), directory("open")];
      if (path === "/project/closed") throw failure("EACCES");
      if (path === "/project/open") return [file("visible.txt")];
      throw failure("ENOENT");
    });

    const scan = await scanFilesystemWorktree("/project", ALL_COVERAGE, 100);

    expect([...scan.files.keys()]).toEqual(["open/visible.txt"]);
    expect(scan.truncated).toBe(true);
  });
});
