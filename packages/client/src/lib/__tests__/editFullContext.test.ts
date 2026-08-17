import { describe, expect, it } from "vitest";
import {
  deriveReplacementFromPatch,
  locateUniqueExact,
  locateUniqueWhitespaceInsensitive,
  reconstructOriginalFile,
} from "../editFullContext";

describe("locateUniqueExact", () => {
  it("returns the only occurrence", () => {
    expect(locateUniqueExact("abcXdef", "X")).toEqual({ start: 3, end: 4 });
  });

  it("rejects missing or repeated needles", () => {
    expect(locateUniqueExact("abc", "X")).toBeNull();
    expect(locateUniqueExact("XaX", "X")).toBeNull();
    expect(locateUniqueExact("abc", "")).toBeNull();
  });
});

describe("locateUniqueWhitespaceInsensitive", () => {
  it("matches a unique indented block", () => {
    const file = ["keep", "  foo {", "    bar();", "  }", "tail"].join("\n");
    const needle = ["foo {", "bar();", "}"].join("\n");
    expect(locateUniqueWhitespaceInsensitive(file, needle)).toEqual({
      start: 1,
      end: 4,
    });
  });

  it("rejects a whitespace-only needle and repeated blocks", () => {
    expect(locateUniqueWhitespaceInsensitive("a\n\nb", "\n")).toBeNull();
    const file = ["foo", "bar", "foo", "bar"].join("\n");
    expect(locateUniqueWhitespaceInsensitive(file, "foo\nbar")).toBeNull();
  });
});

describe("deriveReplacementFromPatch", () => {
  it("rebuilds old and new sides from a single hunk", () => {
    expect(
      deriveReplacementFromPatch([
        {
          lines: [" keep", "-old", "+new", " tail"],
        },
      ]),
    ).toEqual({
      oldString: "keep\nold\ntail",
      newString: "keep\nnew\ntail",
    });
  });

  it("ignores multi-hunk patches", () => {
    expect(
      deriveReplacementFromPatch([{ lines: ["+a"] }, { lines: ["+b"] }]),
    ).toBeNull();
  });
});

describe("reconstructOriginalFile", () => {
  it("inverts a unique post-edit exact match", () => {
    expect(
      reconstructOriginalFile({
        currentFile: "head\nnew line\ntail\n",
        oldString: "old line",
        newString: "new line",
      }),
    ).toBe("head\nold line\ntail\n");
  });

  it("removes a whole-line insertion without leaving a blank line", () => {
    expect(
      reconstructOriginalFile({
        currentFile: "keep\nadded\n",
        oldString: "",
        newString: "added",
      }),
    ).toBe("keep\n");
  });

  it("inverts a unique whitespace-insensitive post-edit match", () => {
    expect(
      reconstructOriginalFile({
        currentFile: ["head", "    added   item", "tail"].join("\n"),
        oldString: "",
        newString: "added item",
      }),
    ).toBe("head\ntail");
  });

  it("treats a unique pre-edit exact match as the original snapshot", () => {
    expect(
      reconstructOriginalFile({
        currentFile: "head\n  old line\ntail",
        oldString: "old line",
        newString: "new line",
      }),
    ).toBe("head\n  old line\ntail");
  });

  it("normalizes a unique pre-edit whitespace-insensitive match", () => {
    expect(
      reconstructOriginalFile({
        currentFile: "head\n  old   line\ntail",
        oldString: "old line",
        newString: "new line",
      }),
    ).toBe("head\nold line\ntail");
  });

  it("derives the replacement from a single hunk when old/new are empty", () => {
    expect(
      reconstructOriginalFile({
        currentFile: "before\nadded\nafter",
        oldString: "",
        newString: "",
        structuredPatch: [
          {
            lines: [" before", "+added", " after"],
          },
        ],
      }),
    ).toBe("before\nafter");
  });

  it("drops identification when the new side is ambiguous", () => {
    expect(
      reconstructOriginalFile({
        currentFile: "new\nmiddle\nnew",
        oldString: "old",
        newString: "new",
      }),
    ).toBeNull();
  });

  it("returns null when neither side can be placed", () => {
    expect(
      reconstructOriginalFile({
        currentFile: "unrelated",
        oldString: "old",
        newString: "new",
      }),
    ).toBeNull();
  });
});
