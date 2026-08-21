import { describe, expect, it } from "vitest";
import {
  buildNpmCommandArgs,
  resolveNpmCommandTarget,
} from "../../src/utils/npmCommand.js";

describe("npm command target", () => {
  it("uses a direct npm argument vector on POSIX", () => {
    const target = resolveNpmCommandTarget("linux");
    expect(target).toEqual({ command: "npm", argsPrefix: [] });
    expect(buildNpmCommandArgs(target, ["root", "-g"])).toEqual(["root", "-g"]);
  });

  it("routes the Windows npm shim through native cmd.exe", () => {
    const target = resolveNpmCommandTarget("win32");
    expect(target.command).toBe("cmd.exe");
    expect(
      buildNpmCommandArgs(target, ["install", "-g", "@openai/codex@latest"]),
    ).toEqual([
      "/d",
      "/s",
      "/c",
      "npm.cmd",
      "install",
      "-g",
      "@openai/codex@latest",
    ]);
  });
});
