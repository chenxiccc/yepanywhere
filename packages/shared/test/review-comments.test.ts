import { describe, expect, it } from "vitest";
import type { PatchHunk } from "../src/types.js";
import {
  type ReviewCommentsFile,
  anchorFromPatch,
  emptyReviewCommentsFile,
  migrateLegacyReviewCommentsFile,
  parseReviewCommentsFile,
  parseReviewStoreFile,
  patchLineCount,
} from "../src/review-comments.js";

// A hunk with 2 context, 1 removed, 2 added, 2 trailing context lines.
//   old: 10 c1 · 11 c2 · 12 removed1 · 13 c3 · 14 c4      (oldLines = 5)
//   new: 10 c1 · 11 c2 · 12 added1 · 13 added2 · 14 c3 · 15 c4  (newLines = 6)
// flat index: 0 c1 · 1 c2 · 2 removed1 · 3 added1 · 4 added2 · 5 c3 · 6 c4
const HUNK: PatchHunk = {
  oldStart: 10,
  oldLines: 5,
  newStart: 10,
  newLines: 6,
  lines: [
    " context1",
    " context2",
    "-removed1",
    "+added1",
    "+added2",
    " context3",
    " context4",
  ],
};

describe("anchorFromPatch", () => {
  it("locates the first context line at the hunk boundary", () => {
    expect(anchorFromPatch([HUNK], 0)).toEqual({
      side: "new",
      oldLine: 10,
      newLine: 10,
      snippet: expect.stringContaining("context1"),
      snippetAnchorOffset: 0,
    });
  });

  it("gives a removed line its old number and a null new line", () => {
    const loc = anchorFromPatch([HUNK], 2);
    expect(loc).toMatchObject({ side: "old", oldLine: 12, newLine: null });
  });

  it("gives added lines their new numbers and a null old line", () => {
    expect(anchorFromPatch([HUNK], 3)).toMatchObject({
      side: "new",
      oldLine: null,
      newLine: 12,
    });
    expect(anchorFromPatch([HUNK], 4)).toMatchObject({
      side: "new",
      oldLine: null,
      newLine: 13,
    });
  });

  it("advances both counters past inserts/deletes for trailing context", () => {
    expect(anchorFromPatch([HUNK], 5)).toMatchObject({
      oldLine: 13,
      newLine: 14,
    });
    // last line of the hunk
    expect(anchorFromPatch([HUNK], 6)).toMatchObject({
      oldLine: 14,
      newLine: 15,
    });
  });

  it("honours contextSide for context lines only", () => {
    expect(anchorFromPatch([HUNK], 0, 3, "old")).toMatchObject({
      side: "old",
      oldLine: 10,
      newLine: 10,
    });
    // a removed line ignores contextSide
    expect(anchorFromPatch([HUNK], 2, 3, "new")).toMatchObject({
      side: "old",
    });
  });

  it("builds a snippet of the clicked line plus neighbours", () => {
    const loc = anchorFromPatch([HUNK], 3, 1);
    expect(loc?.snippet).toBe("removed1\nadded1\nadded2");
    // clicked line ("added1") sits at offset 1 within the snippet
    expect(loc?.snippetAnchorOffset).toBe(1);
    expect(loc?.snippet.split("\n")[loc.snippetAnchorOffset]).toBe("added1");
  });

  it("offset is clamped at a hunk-start click (no leading context)", () => {
    // flat index 0 is the first line of the hunk: no lines precede it.
    const loc = anchorFromPatch([HUNK], 0, 3);
    expect(loc?.snippetAnchorOffset).toBe(0);
    expect(loc?.snippet.split("\n")[0]).toBe("context1");
  });

  it("walks across hunks by flat index", () => {
    const second: PatchHunk = {
      oldStart: 40,
      oldLines: 2,
      newStart: 41,
      newLines: 2,
      lines: [" a", " b"],
    };
    // 7 lines in HUNK, so flat index 7 is the first line of `second`.
    expect(anchorFromPatch([HUNK, second], 7)).toMatchObject({
      oldLine: 40,
      newLine: 41,
    });
    expect(anchorFromPatch([HUNK, second], 8)).toMatchObject({
      oldLine: 41,
      newLine: 42,
    });
  });

  it("returns null for out-of-range or negative indices", () => {
    expect(anchorFromPatch([HUNK], 7)).toBeNull();
    expect(anchorFromPatch([HUNK], -1)).toBeNull();
    expect(anchorFromPatch([HUNK], 1.5)).toBeNull();
    expect(anchorFromPatch([], 0)).toBeNull();
  });

  it("patchLineCount counts real diff lines, not headers", () => {
    expect(patchLineCount([HUNK])).toBe(7);
    expect(patchLineCount([])).toBe(0);
  });
});

describe("parseReviewCommentsFile", () => {
  const roundTrippable: ReviewCommentsFile = {
    version: 1,
    comments: [
      {
        id: "c1",
        anchor: {
          path: "src/a.ts",
          revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
          side: "new",
          oldLine: null,
          newLine: 12,
          snippet: "added1",
          snippetAnchorOffset: 0,
        },
        text: "why this?",
        status: "pending",
        createdAt: "2026-07-26T00:00:00Z",
      },
      {
        id: "c2",
        anchor: {
          path: "src/b.ts",
          revision: { kind: "sha", sha: "abc1234" },
          side: "old",
          oldLine: 5,
          newLine: null,
          snippet: "removed1",
        },
        text: "gone now",
        status: "archived",
        createdAt: "2026-07-25T00:00:00Z",
        archivedAt: "2026-07-26T01:00:00Z",
        batchId: "b1",
        targetSessionId: "sess-1",
      },
    ],
    batches: [
      {
        id: "b1",
        submittedAt: "2026-07-26T01:00:00Z",
        targetSessionId: "sess-1",
        commentIds: ["c2"],
      },
    ],
  };

  it("round-trips a persisted store through JSON", () => {
    const json = JSON.parse(JSON.stringify(roundTrippable));
    expect(parseReviewCommentsFile(json)).toEqual(roundTrippable);
  });

  it("rejects garbage to an empty store rather than throwing", () => {
    for (const bad of [null, undefined, 42, "nope", [], true]) {
      expect(parseReviewCommentsFile(bad)).toEqual(emptyReviewCommentsFile());
    }
  });

  it("rejects a missing or wrong version to empty", () => {
    expect(parseReviewCommentsFile({ comments: [], batches: [] })).toEqual(
      emptyReviewCommentsFile(),
    );
    expect(
      parseReviewCommentsFile({ version: 2, comments: [], batches: [] }),
    ).toEqual(emptyReviewCommentsFile());
  });

  it("drops malformed comments but keeps valid ones", () => {
    const parsed = parseReviewCommentsFile({
      version: 1,
      comments: [
        roundTrippable.comments[0],
        { id: "bad", anchor: { path: "" }, text: "x", status: "pending" },
        { id: "c1", anchor: {}, text: "dup id but broken" }, // dup + broken
        {
          // a line that exists on no side is invalid
          id: "nosides",
          anchor: {
            path: "z.ts",
            revision: { kind: "sha", sha: "deadbee" },
            side: "new",
            oldLine: null,
            newLine: null,
            snippet: "",
          },
          text: "x",
          status: "pending",
          createdAt: "2026-07-26T00:00:00Z",
        },
      ],
      batches: [],
    });
    expect(parsed.comments).toHaveLength(1);
    expect(parsed.comments[0]?.id).toBe("c1");
  });

  it("dedupes comment ids, keeping the first", () => {
    const parsed = parseReviewCommentsFile({
      version: 1,
      comments: [roundTrippable.comments[0], roundTrippable.comments[0]],
      batches: [],
    });
    expect(parsed.comments).toHaveLength(1);
  });

  it("tolerates truncated/partial objects without throwing", () => {
    expect(() =>
      parseReviewCommentsFile({ version: 1, comments: [{ id: "x" }] }),
    ).not.toThrow();
    expect(
      parseReviewCommentsFile({ version: 1, comments: [{ id: "x" }] }).comments,
    ).toHaveLength(0);
  });
});

describe("review store migration", () => {
  it("preserves every legacy draft, archived comment, and batch", () => {
    const legacy = parseReviewCommentsFile({
      version: 1,
      comments: [
        {
          id: "draft-1",
          anchor: {
            path: "src/a.ts",
            revision: { kind: "uncommitted", savedAt: "2026-08-01T00:00:00Z" },
            side: "new",
            oldLine: null,
            newLine: 4,
            snippet: "draft",
          },
          text: "pending",
          status: "pending",
          createdAt: "2026-08-01T00:00:00Z",
        },
        {
          id: "archived-1",
          anchor: {
            path: "src/b.ts",
            revision: { kind: "sha", sha: "abcdef1" },
            side: "old",
            oldLine: 8,
            newLine: null,
            snippet: "gone",
          },
          text: "history",
          status: "archived",
          createdAt: "2026-07-31T00:00:00Z",
          archivedAt: "2026-08-01T01:00:00Z",
          batchId: "batch-1",
          targetSessionId: "session-1",
        },
      ],
      batches: [
        {
          id: "batch-1",
          submittedAt: "2026-08-01T01:00:00Z",
          targetSessionId: "session-1",
          commentIds: ["archived-1"],
        },
        {
          id: "empty-batch",
          submittedAt: "2026-08-01T02:00:00Z",
          targetSessionId: "session-2",
          commentIds: [],
        },
      ],
    });

    const migrated = migrateLegacyReviewCommentsFile(legacy);
    expect(migrated.version).toBe(2);
    expect(migrated.sites).toHaveLength(2);
    expect(migrated.drafts).toEqual([
      { siteId: "legacy-site-draft-1", entryId: "draft-1" },
    ]);
    expect(migrated.submissions).toHaveLength(2);
    expect(migrated.sites[1]?.entries[0]?.capture).toEqual({
      status: "legacy-missing",
    });
    expect(migrated.submissions[0]?.entryRefs).toEqual([
      { siteId: "legacy-site-archived-1", entryId: "archived-1" },
    ]);
  });

  it("parses version 1 by migrating and round-trips canonical version 2", () => {
    const migrated = parseReviewStoreFile({
      version: 1,
      comments: [],
      batches: [],
    });
    expect(migrated.version).toBe(2);
    expect(parseReviewStoreFile(JSON.parse(JSON.stringify(migrated)))).toEqual(
      migrated,
    );
  });
});
