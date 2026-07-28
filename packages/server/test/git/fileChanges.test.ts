import { describe, expect, it } from "vitest";
import { buildGitFileChanges } from "../../src/git/fileChanges.js";

describe("buildGitFileChanges", () => {
  it("preserves tabs and newlines in NUL-delimited paths", () => {
    const tabPath = "src/tab\tname.ts";
    const newlinePath = "src/line\nname.ts";

    expect(
      buildGitFileChanges(
        `M\x00${tabPath}\x00A\x00${newlinePath}\x00`,
        `3\t1\t${tabPath}\x007\t0\t${newlinePath}\x00`,
      ),
    ).toEqual([
      {
        path: tabPath,
        status: "M",
        staged: false,
        linesAdded: 3,
        linesDeleted: 1,
      },
      {
        path: newlinePath,
        status: "A",
        staged: false,
        linesAdded: 7,
        linesDeleted: 0,
      },
    ]);
  });

  it("aligns rename counts without parsing the rename display path", () => {
    const oldPath = "src/old\tname.ts";
    const newPath = "src/new\nname.ts";

    expect(
      buildGitFileChanges(
        `R100\x00${oldPath}\x00${newPath}\x00M\x00src/other.ts\x00`,
        `5\t2\t\x00${oldPath}\x00${newPath}\x000\t4\tsrc/other.ts\x00`,
      ),
    ).toEqual([
      {
        path: newPath,
        origPath: oldPath,
        status: "R",
        staged: false,
        linesAdded: 5,
        linesDeleted: 2,
      },
      {
        path: "src/other.ts",
        status: "M",
        staged: false,
        linesAdded: 0,
        linesDeleted: 4,
      },
    ]);
  });
});
