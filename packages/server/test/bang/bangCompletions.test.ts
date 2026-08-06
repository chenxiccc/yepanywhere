/**
 * Bang completion candidates: PATH + project-root executables for the
 * command token, project-relative paths for argument tokens, and the
 * allowlist-gated acli `--acli-complete` protocol.
 * Contract: topics/bang-commands.md.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listAcliArgCompletions,
  listBangCommandCompletions,
  listBangPathCompletions,
  resetBangCompletionCache,
} from "../../src/services/bangCompletions.js";
import { classifyBangOutput } from "../../src/routes/bang-commands.js";

let binDir: string;
let projectDir: string;

beforeEach(async () => {
  binDir = await fs.mkdtemp(path.join(os.tmpdir(), "ya-bang-bin-"));
  projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "ya-bang-proj-"));
  resetBangCompletionCache();
});

afterEach(async () => {
  await fs.rm(binDir, { recursive: true, force: true });
  await fs.rm(projectDir, { recursive: true, force: true });
  resetBangCompletionCache();
  vi.unstubAllEnvs();
});

async function addExecutable(dir: string, name: string, body = "echo hi\n") {
  const filePath = path.join(dir, name);
  await fs.writeFile(filePath, `#!/usr/bin/env bash\n${body}`);
  execSync(`chmod +x ${filePath}`);
}

describe("listBangCommandCompletions", () => {
  it("completes from PATH and the project root, executables only", async () => {
    await addExecutable(binDir, "gitalike");
    await addExecutable(binDir, "gizmo");
    await fs.writeFile(path.join(binDir, "gitnotexec"), "not executable");
    await addExecutable(projectDir, "gimme");
    const completions = await listBangCommandCompletions({
      prefix: "gi",
      projectPath: projectDir,
      pathEnv: binDir,
    });
    expect(completions).toEqual(["gimme", "gitalike", "gizmo"]);
  });
});

describe("listBangPathCompletions", () => {
  it("completes project-relative paths with directory suffixes", async () => {
    await fs.mkdir(path.join(projectDir, "src"));
    await fs.writeFile(path.join(projectDir, "src", "main.ts"), "");
    await fs.writeFile(path.join(projectDir, "src", "map.ts"), "");
    await fs.writeFile(path.join(projectDir, "src", "other.ts"), "");
    const completions = await listBangPathCompletions({
      tokenPrefix: "src/ma",
      projectPath: projectDir,
    });
    expect(completions).toEqual(["src/main.ts", "src/map.ts"]);
    const dirs = await listBangPathCompletions({
      tokenPrefix: "sr",
      projectPath: projectDir,
    });
    expect(dirs).toEqual(["src/"]);
  });

  it("refuses to escape the project root", async () => {
    expect(
      await listBangPathCompletions({
        tokenPrefix: "../",
        projectPath: projectDir,
      }),
    ).toEqual([]);
  });
});

describe("listAcliArgCompletions", () => {
  const fixtures = path.join(__dirname, "fixtures");

  it("asks an allowlisted acli tool for completions", async () => {
    await fs.copyFile(
      path.join(fixtures, "harness-check"),
      path.join(projectDir, "harness-check"),
    );
    execSync(`chmod +x ${path.join(projectDir, "harness-check")}`);
    const completions = await listAcliArgCompletions({
      line: "harness-check --harnesses cl",
      projectPath: projectDir,
    });
    expect(completions).toEqual(["claude"]);
  });

  it("completes within the last pipeline segment", async () => {
    await fs.copyFile(
      path.join(fixtures, "harness-check"),
      path.join(projectDir, "harness-check"),
    );
    execSync(`chmod +x ${path.join(projectDir, "harness-check")}`);
    const completions = await listAcliArgCompletions({
      line: "ls | harness-check --m",
      projectPath: projectDir,
    });
    expect(completions).toEqual(["--md"]);
  });

  it("returns null for non-allowlisted commands", async () => {
    expect(
      await listAcliArgCompletions({
        line: "definitely-not-allowlisted --x",
        projectPath: projectDir,
      }),
    ).toBeNull();
  });
});

describe("classifyBangOutput", () => {
  it("classifies JSONL, JSON, ANSI, TOON, markdown, and empty output", () => {
    expect(classifyBangOutput('{"a":1}\n{"a":2}\n')).toBe("json");
    expect(classifyBangOutput('{"a":1,"b":[1,2]}')).toBe("json");
    expect(classifyBangOutput("\u001b[31mred\u001b[0m\n")).toBe("ansi");
    expect(classifyBangOutput("items[2]{a,b}:\n1,2\n3,4\n")).toBe("toon");
    expect(classifyBangOutput("# Report\n\nAll good.\n")).toBe("markdown");
    expect(classifyBangOutput("   \n")).toBe("raw");
    // A TOON-looking header with malformed rows falls back to raw fencing.
    expect(classifyBangOutput("items[3]{a,b}:\n1,2\n")).toBe("raw");
  });
});
