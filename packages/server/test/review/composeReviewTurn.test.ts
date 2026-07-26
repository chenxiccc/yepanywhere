import type { ReviewComment, ReviewCommentAnchor } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { composeReviewTurn } from "../../src/review/composeReviewTurn.js";
import type { AnchorRelocation } from "../../src/review/relocateAnchors.js";

function comment(
  id: string,
  text: string,
  anchor: Partial<ReviewCommentAnchor>,
): ReviewComment {
  return {
    id,
    text,
    status: "pending",
    createdAt: "2026-07-26T00:00:00Z",
    anchor: {
      path: "src/a.ts",
      revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
      side: "new",
      oldLine: null,
      newLine: 10,
      snippet: "code here",
      snippetAnchorOffset: 0,
      ...anchor,
    },
  };
}

const relocated = (line: number, snippet = "code here"): AnchorRelocation => ({
  status: "relocated",
  path: "src/a.ts",
  line,
  snippet,
  currentSha: "abc1234def",
  moved: false,
});

const gone = (citeSha: string | null): AnchorRelocation => ({
  status: "gone",
  path: "src/a.ts",
  citeSha,
  snippet: "old code",
});

const REVIEW_FILE = ".yep/review-comments.json";

describe("composeReviewTurn", () => {
  it("includes the read-current-state instruction and review-file reference", () => {
    const prompt = composeReviewTurn({
      comments: [comment("c1", "why?", {})],
      relocations: new Map([["c1", relocated(10)]]),
      reviewFileRelPath: REVIEW_FILE,
    });
    expect(prompt.toLowerCase()).toContain("source review");
    expect(prompt).toContain("Read the current file state");
    expect(prompt).toContain(REVIEW_FILE);
    expect(prompt).toContain("why?");
  });

  it("cites a sha only for gone comments, never relocated ones", () => {
    const prompt = composeReviewTurn({
      comments: [
        comment("c1", "still here", {}),
        comment("c2", "vanished", { newLine: 20 }),
      ],
      relocations: new Map<string, AnchorRelocation>([
        ["c1", relocated(10)],
        ["c2", gone("deadbeef1")],
      ]),
      reviewFileRelPath: REVIEW_FILE,
    });
    // relocated comment shows path:line and no sha
    expect(prompt).toContain("src/a.ts:10");
    expect(prompt).not.toContain("abc1234def"); // currentSha never cited
    // gone comment cites its sha
    expect(prompt).toContain("deadbeef1");
  });

  it("always cites the sha for a removed (minus-side) comment", () => {
    const prompt = composeReviewTurn({
      comments: [
        comment("c1", "removed code", {
          side: "old",
          oldLine: 5,
          newLine: null,
          revision: { kind: "sha", sha: "cafe1234" },
        }),
      ],
      relocations: new Map([["c1", gone("cafe1234")]]),
      reviewFileRelPath: REVIEW_FILE,
    });
    expect(prompt).toContain("cafe1234");
  });

  it("groups comments by file, one heading per path", () => {
    const prompt = composeReviewTurn({
      comments: [
        comment("c1", "a1", { path: "src/a.ts", newLine: 10 }),
        comment("c2", "b1", { path: "src/b.ts", newLine: 3 }),
        comment("c3", "a2", { path: "src/a.ts", newLine: 20 }),
      ],
      relocations: new Map<string, AnchorRelocation>([
        ["c1", { ...relocated(10), path: "src/a.ts" }],
        ["c2", { ...relocated(3), path: "src/b.ts" }],
        ["c3", { ...relocated(20), path: "src/a.ts" }],
      ]),
      reviewFileRelPath: REVIEW_FILE,
    });
    expect(prompt.match(/^## src\/a\.ts$/gm)).toHaveLength(1);
    expect(prompt.match(/^## src\/b\.ts$/gm)).toHaveLength(1);
  });

  it("carries both old and new line for a diff (context) comment", () => {
    const prompt = composeReviewTurn({
      comments: [comment("c1", "context change", { oldLine: 8, newLine: 10 })],
      relocations: new Map([["c1", relocated(10)]]),
      reviewFileRelPath: REVIEW_FILE,
    });
    expect(prompt).toContain("old L8");
    expect(prompt).toContain("new L10");
  });

  it("marks a follow-up turn distinctly", () => {
    const prompt = composeReviewTurn({
      comments: [comment("c1", "x", {})],
      relocations: new Map([["c1", relocated(10)]]),
      reviewFileRelPath: REVIEW_FILE,
      followUp: true,
    });
    expect(prompt).toContain("follow-up");
  });
});
