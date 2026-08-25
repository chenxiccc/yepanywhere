import { beforeEach, describe, expect, it } from "vitest";
import {
  formatSessionFileComment,
  formatSessionFileCommentBatch,
  loadSessionFileCommentDrafts,
  saveSessionFileCommentDrafts,
  sessionFileCommentDraftKey,
  type SessionFileCommentDraft,
} from "../sessionFileComments";

const first: SessionFileCommentDraft = {
  id: "first",
  location: "src/example.ts:4-5",
  quote: "const first = 1;\nconst second = 2;",
  text: "  Should these share a name?  ",
  afterLine: 5,
};

describe("session file comments", () => {
  beforeEach(() => localStorage.clear());

  it("formats only the location, quoted source, and comment", () => {
    expect(formatSessionFileComment(first)).toBe(
      "src/example.ts:4-5\n\n> const first = 1;\n> const second = 2;\n\nShould these share a name?",
    );
  });

  it("groups deferred comments with the ordinary separator", () => {
    expect(
      formatSessionFileCommentBatch([
        first,
        {
          id: "second",
          location: "src/example.ts:9",
          quote: "return first;",
          text: "Is this still reachable?",
          afterLine: 9,
        },
      ]),
    ).toBe(
      "src/example.ts:4-5\n\n> const first = 1;\n> const second = 2;\n\nShould these share a name?\n\n---\n\nsrc/example.ts:9\n\n> return first;\n\nIs this still reachable?",
    );
  });

  it("persists nonempty drafts defensively under a session-scoped key", () => {
    const key = sessionFileCommentDraftKey({
      sourceKey: "local",
      sessionId: "session-id",
      projectId: "project-id",
      filePath: "src/example.ts",
    });
    saveSessionFileCommentDrafts(key, [
      first,
      { ...first, id: "empty", text: "   " },
    ]);

    expect(loadSessionFileCommentDrafts(key)).toEqual([first]);
    localStorage.setItem(key, '{"not":"drafts"}');
    expect(loadSessionFileCommentDrafts(key)).toEqual([]);
    localStorage.setItem(key, "not json");
    expect(loadSessionFileCommentDrafts(key)).toEqual([]);
  });
});
