import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ReviewCommentAnchor } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type RelocatedAnchor,
  relocateAnchor,
} from "../../src/review/relocateAnchors.js";

const execFileAsync = promisify(execFile);

const FILE = "src/answer.ts";
const BASE = [
  "line one",
  "line two",
  "const answer = 42;",
  "line four",
  "line five",
];

describe("relocateAnchor", () => {
  let dir: string;

  async function git(...args: string[]): Promise<string> {
    const { stdout } = await execFileAsync("git", ["-C", dir, ...args]);
    return stdout.trim();
  }

  async function writeFileLines(lines: string[]): Promise<void> {
    await writeFile(join(dir, FILE), `${lines.join("\n")}\n`, "utf-8");
  }

  async function commitAll(message: string): Promise<string> {
    await git("add", "-A");
    await git("commit", "-m", message);
    return git("rev-parse", "HEAD");
  }

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-reloc-"));
    await git("init");
    await git("config", "user.email", "ya-test@example.com");
    await git("config", "user.name", "YA Test");
    await execFileAsync("mkdir", ["-p", join(dir, "src")]);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** Anchor on the `const answer = 42;` line (line 3 of BASE). */
  function answerAnchor(
    overrides: Partial<ReviewCommentAnchor> = {},
  ): ReviewCommentAnchor {
    return {
      path: FILE,
      revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
      side: "new",
      oldLine: null,
      newLine: 3,
      snippet: "line two\nconst answer = 42;\nline four",
      snippetAnchorOffset: 1,
      ...overrides,
    };
  }

  it("relocates an unchanged line at the same number, with its blame sha", async () => {
    await writeFileLines(BASE);
    const sha = await commitAll("base");

    const result = (await relocateAnchor(
      dir,
      answerAnchor(),
    )) as RelocatedAnchor;
    expect(result.status).toBe("relocated");
    expect(result.line).toBe(3);
    expect(result.moved).toBe(false);
    expect(result.currentSha).toBe(sha);
    expect(result.snippet).toContain("const answer = 42;");
  });

  it("fuzzy-relocates a line shifted down by edits above it", async () => {
    await writeFileLines(BASE);
    await commitAll("base");
    // Prepend two lines in the working tree without committing.
    await writeFileLines(["new top 1", "new top 2", ...BASE]);

    const result = (await relocateAnchor(
      dir,
      answerAnchor(),
    )) as RelocatedAnchor;
    expect(result.status).toBe("relocated");
    expect(result.line).toBe(5);
    expect(result.moved).toBe(true);
  });

  it("reports gone (with cited sha) when the line was deleted", async () => {
    await writeFileLines(BASE);
    const sha = await commitAll("base");
    // Delete the answer line in the working tree.
    await writeFileLines(BASE.filter((l) => !l.includes("answer")));

    const result = await relocateAnchor(
      dir,
      answerAnchor({ revision: { kind: "sha", sha } }),
    );
    expect(result.status).toBe("gone");
    if (result.status === "gone") expect(result.citeSha).toBe(sha);
  });

  it("acquires the commit sha for an uncommitted anchor since committed", async () => {
    await writeFileLines(BASE);
    await commitAll("base");
    // Add a distinctive line in the working tree; anchor it while uncommitted.
    await writeFileLines([...BASE, "const extra = 7;"]);
    const anchor = answerAnchor({
      newLine: 6,
      snippet: "line four\nline five\nconst extra = 7;",
      snippetAnchorOffset: 2,
      revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
    });
    // Now commit the change: the line acquires a real sha.
    const sha = await commitAll("add extra");

    const result = (await relocateAnchor(dir, anchor)) as RelocatedAnchor;
    expect(result.status).toBe("relocated");
    expect(result.line).toBe(6);
    expect(result.currentSha).toBe(sha);
  });

  it("treats a removed (`-`-side) anchor as gone by definition", async () => {
    await writeFileLines(BASE);
    const sha = await commitAll("base");
    const anchor = answerAnchor({
      side: "old",
      oldLine: 3,
      newLine: null,
      revision: { kind: "sha", sha },
    });
    const result = await relocateAnchor(dir, anchor);
    expect(result.status).toBe("gone");
    if (result.status === "gone") expect(result.citeSha).toBe(sha);
  });

  it("reports gone when the file itself is missing", async () => {
    const result = await relocateAnchor(dir, answerAnchor());
    expect(result.status).toBe("gone");
  });
});
