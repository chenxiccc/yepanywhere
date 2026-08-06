/**
 * The toy acli tool behind bang-command tests: JSONL default, --pretty,
 * --md, --toon formats, the --acli-complete verb, and fail-loud unknown
 * flags. Contract: topics/bang-commands.md; acli spec:
 * ~/agents topics/agent-cli.md.
 */

import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import { parseToonDocument } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const FIXTURES = path.join(__dirname, "fixtures");
const TOOL = path.join(FIXTURES, "harness-check");
const REGISTRY = path.join(FIXTURES, "registry.json");
const STUB_BIN = path.join(FIXTURES, "bin");

function runTool(args: string[]) {
  return execFileAsync(process.execPath, [TOOL, ...args], {
    env: {
      ...process.env,
      PATH: `${STUB_BIN}${path.delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

const CHECK_ARGS = [
  "--registry",
  REGISTRY,
  "--harnesses",
  "claude,codex,gemini",
];

describe("harness-check fixture tool", () => {
  it("emits compact JSONL by default with update detection", async () => {
    const { stdout } = await runTool(CHECK_ARGS);
    const rows = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toEqual([
      {
        harness: "claude",
        installed: "1.0.0",
        latest: "1.0.0",
        status: "up-to-date",
      },
      {
        harness: "codex",
        installed: "2.0.0",
        latest: "2.5.0",
        status: "update-available",
      },
      {
        harness: "gemini",
        installed: null,
        latest: "3.0.0",
        status: "not-installed",
      },
    ]);
  });

  it("emits a pretty JSON array with --pretty", async () => {
    const { stdout } = await runTool(["--pretty", ...CHECK_ARGS]);
    const rows = JSON.parse(stdout);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(3);
  });

  it("emits a markdown report with --md", async () => {
    const { stdout } = await runTool(["--md", ...CHECK_ARGS]);
    expect(stdout).toContain("## Harness updates");
    expect(stdout).toContain("| codex | 2.0.0 | 2.5.0 | update-available |");
    expect(stdout).toContain("**1 update(s) available:** codex");
  });

  it("emits a parseable TOON flat table with --toon", async () => {
    const { stdout } = await runTool(["--toon", ...CHECK_ARGS]);
    const tables = parseToonDocument(stdout);
    expect(tables).not.toBeNull();
    expect(tables?.[0]?.columns).toEqual([
      "harness",
      "installed",
      "latest",
      "status",
    ]);
    expect(tables?.[0]?.rows).toHaveLength(3);
    expect(tables?.[0]?.rows[1]).toEqual([
      "codex",
      "2.0.0",
      "2.5.0",
      "update-available",
    ]);
  });

  it("answers --acli-complete with JSONL candidates", async () => {
    const flags = await runTool(["--acli-complete", "--"]);
    const flagCandidates = flags.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).completion);
    expect(flagCandidates).toContain("--md");
    expect(flagCandidates).toContain("--harnesses");

    const values = await runTool(["--acli-complete", "--harnesses", "co"]);
    expect(values.stdout.trim()).toBe(JSON.stringify({ completion: "codex" }));
  });

  it("fails loud on unknown flags", async () => {
    await expect(runTool(["--nope"])).rejects.toMatchObject({ code: 2 });
  });
});
