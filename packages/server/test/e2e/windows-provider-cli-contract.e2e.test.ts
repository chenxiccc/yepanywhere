import { execFile } from "node:child_process";
import { win32 as windowsPath } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parseCommandLookupOutput } from "../../src/sdk/cli-detection.js";
import { OpenCodeProvider } from "../../src/sdk/providers/opencode.js";
import { PiProvider } from "../../src/sdk/providers/pi.js";

const execFileAsync = promisify(execFile);
const describeWindowsProviderContract =
  process.platform === "win32" &&
  process.env.WINDOWS_PROVIDER_CONTRACT_TEST === "true"
    ? describe
    : describe.skip;

async function whereCandidates(command: string): Promise<string[]> {
  const { stdout } = await execFileAsync("where.exe", [command], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return parseCommandLookupOutput(stdout);
}

describeWindowsProviderContract("Windows provider CLI contract", () => {
  it("detects and launches npm-installed OpenCode and Pi", async () => {
    const [opencodePaths, piPaths] = await Promise.all([
      whereCandidates("opencode"),
      whereCandidates("pi"),
    ]);

    expect(opencodePaths.map((path) => windowsPath.basename(path))).toEqual(
      expect.arrayContaining(["opencode", "opencode.cmd"]),
    );
    expect(piPaths.map((path) => windowsPath.basename(path))).toEqual(
      expect.arrayContaining(["pi", "pi.cmd"]),
    );

    const opencode = new OpenCodeProvider();
    await expect(opencode.getAuthStatus()).resolves.toMatchObject({
      installed: true,
      authenticated: true,
      enabled: true,
    });
    const opencodeModels = await opencode.getAvailableModels();
    expect(opencodeModels.length).toBeGreaterThan(0);

    const pi = new PiProvider();
    await expect(pi.getAuthStatus()).resolves.toMatchObject({
      installed: true,
      authenticated: true,
      enabled: true,
    });
    const piModels = await pi.getAvailableModels();
    expect(piModels).toContainEqual(
      expect.objectContaining({ id: "default", name: "Default" }),
    );
  }, 240_000);
});
