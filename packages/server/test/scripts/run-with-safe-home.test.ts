import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../..",
);
const launcher = join(repositoryRoot, "scripts/run-with-safe-home.js");

describe("run-with-safe-home", () => {
  it("owns and removes a disposable child home", async () => {
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn(process.execPath, [
        launcher,
        "--temporary-home",
        process.execPath,
        "-e",
        "console.log(JSON.stringify({home:require('node:os').homedir(),HOME:process.env.HOME,USERPROFILE:process.env.USERPROFILE}))",
      ]);
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", reject);
      child.once("exit", (code) => resolve({ code, stdout, stderr }));
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    const childEnvironment = JSON.parse(result.stdout) as {
      home: string;
      HOME: string;
      USERPROFILE: string;
    };
    expect(childEnvironment.home).not.toBe(homedir());
    expect(childEnvironment.HOME).toBe(childEnvironment.home);
    expect(childEnvironment.USERPROFILE).toBe(childEnvironment.home);
    expect(existsSync(childEnvironment.home)).toBe(false);
  });
});
