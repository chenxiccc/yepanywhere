import { afterEach, describe, expect, it, vi } from "vitest";

type ExecFileCallback = (
  error: Error | null,
  stdout?: string,
  stderr?: string,
) => void;

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
  const actual =
    await vi.importActual<typeof import("node:child_process")>(
      "node:child_process",
    );
  return {
    ...actual,
    execFile: execFileMock,
  };
});

describe("Git execution", () => {
  afterEach(() => {
    execFileMock.mockReset();
    vi.resetModules();
  });

  it("disables optional locks for text and binary commands", async () => {
    execFileMock.mockImplementation(
      (
        _command: string,
        _args: string[],
        _options: unknown,
        callback: ExecFileCallback,
      ) => callback(null, "", ""),
    );
    const { buildGitProcessArgs, runGit, runGitBytes } = await import(
      "../../src/git/gitExec.js"
    );

    expect(buildGitProcessArgs(["clone", "source", "destination"])).toEqual([
      "--no-optional-locks",
      "clone",
      "source",
      "destination",
    ]);

    await runGit("/project", ["status", "--porcelain=v2"]);
    await runGitBytes("/project", ["show", "HEAD:file"]);

    expect(execFileMock).toHaveBeenNthCalledWith(
      1,
      "git",
      ["--no-optional-locks", "-C", "/project", "status", "--porcelain=v2"],
      expect.any(Object),
      expect.any(Function),
    );
    expect(execFileMock).toHaveBeenNthCalledWith(
      2,
      "git",
      ["--no-optional-locks", "-C", "/project", "show", "HEAD:file"],
      expect.any(Object),
      expect.any(Function),
    );
  });
});
