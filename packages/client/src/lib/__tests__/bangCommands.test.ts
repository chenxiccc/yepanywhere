/**
 * Composer bang-draft routing and completion-query parsing.
 * Contract: topics/bang-commands.md.
 */

import type { BangCommandTranscriptDisplayObject } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  applyBangCompletion,
  buildBangEchoText,
  collectBangHistory,
  getBangCompletionQuery,
  longestCommonPrefix,
  resolveComposerBangDraft,
} from "../bangCommands";

function bangObject(
  overrides: Partial<BangCommandTranscriptDisplayObject> = {},
): BangCommandTranscriptDisplayObject {
  return {
    id: "b1",
    kind: "bang-command",
    createdAt: "2026-07-24T00:00:00.000Z",
    placementAfterMessageId: "",
    command: "git status",
    cwd: "/proj",
    status: "done",
    exitCode: 0,
    ...overrides,
  };
}

describe("resolveComposerBangDraft", () => {
  it("routes !!command drafts and trims the command", () => {
    expect(resolveComposerBangDraft("!!git status ")).toEqual({
      kind: "bang",
      command: "git status",
    });
  });

  it("treats bare !! as empty", () => {
    expect(resolveComposerBangDraft("!!")).toEqual({ kind: "empty" });
    expect(resolveComposerBangDraft("!!  ")).toEqual({ kind: "empty" });
  });

  it("strips one leading space as the literal-!! escape", () => {
    expect(resolveComposerBangDraft(" !!important note")).toEqual({
      kind: "escaped",
      text: "!!important note",
    });
  });

  it("leaves ordinary drafts alone", () => {
    expect(resolveComposerBangDraft("hello !!there")).toEqual({
      kind: "none",
    });
  });
});

describe("getBangCompletionQuery", () => {
  it("completes the first token as a command", () => {
    expect(getBangCompletionQuery("!!gi")).toEqual({
      token: "gi",
      kind: "command",
      replaceStart: 2,
    });
  });

  it("completes the token after a pipe/semicolon as a command", () => {
    expect(getBangCompletionQuery("!!git status | w")).toEqual({
      token: "w",
      kind: "command",
      replaceStart: 15,
    });
    expect(getBangCompletionQuery("!!make; cl")).toEqual({
      token: "cl",
      kind: "command",
      replaceStart: 8,
    });
  });

  it("completes later tokens as paths, skipping flags", () => {
    expect(getBangCompletionQuery("!!cat src/ma")).toEqual({
      token: "src/ma",
      kind: "path",
      replaceStart: 6,
    });
    expect(getBangCompletionQuery("!!ls -l")).toBeNull();
  });

  it("returns null outside bang drafts and on multiline drafts", () => {
    expect(getBangCompletionQuery("hello")).toBeNull();
    expect(getBangCompletionQuery("!!a\nb")).toBeNull();
  });
});

describe("applyBangCompletion and longestCommonPrefix", () => {
  it("replaces the token and appends a space for non-directories", () => {
    const query = getBangCompletionQuery("!!gi");
    expect(query && applyBangCompletion("!!gi", query, "git")).toBe("!!git ");
    const pathQuery = getBangCompletionQuery("!!cat sr");
    expect(
      pathQuery && applyBangCompletion("!!cat sr", pathQuery, "src/"),
    ).toBe("!!cat src/");
  });

  it("computes shell-style common prefixes", () => {
    expect(longestCommonPrefix(["gitalike", "gitnot", "git"])).toBe("git");
    expect(longestCommonPrefix([])).toBe("");
    expect(longestCommonPrefix(["abc"])).toBe("abc");
  });
});

describe("collectBangHistory", () => {
  it("returns newest-first deduplicated commands", () => {
    const history = collectBangHistory([
      bangObject({ id: "1", command: "ls", createdAt: "2026-07-24T00:00:01Z" }),
      bangObject({
        id: "2",
        command: "git status",
        createdAt: "2026-07-24T00:00:02Z",
      }),
      bangObject({ id: "3", command: "ls", createdAt: "2026-07-24T00:00:03Z" }),
    ]);
    expect(history).toEqual(["ls", "git status"]);
  });
});

describe("buildBangEchoText", () => {
  it("labels provenance and fences command and output", () => {
    const text = buildBangEchoText(
      bangObject({ exitCode: 2, durationMs: 3200 }),
      { stdout: "clean\n", stderr: "warn\n" },
    );
    expect(text).toContain("I ran this local command myself");
    expect(text).toContain("$ git status");
    expect(text).toContain("clean");
    expect(text).toContain("Stderr:");
    expect(text).toContain("Exit code 2 after 3s.");
  });

  it("uses fences that command text and output cannot close", () => {
    const text = buildBangEchoText(
      bangObject({ command: "printf '```escaped```'" }),
      {
        stdout: "before\n```\nafter\n",
        stderr: "",
      },
    );

    expect(text).toContain("````\n$ printf '```escaped```'\n````");
    expect(text).toContain("````\nbefore\n```\nafter\n````");
  });
});
