/**
 * Global bang command-history matching for Tab completion: prefix-match prior
 * whole `!!` command lines against the current body, most-recent-first,
 * excluding the exact current body. Contract: topics/bang-commands.md.
 */

import { describe, expect, it } from "vitest";
import { matchBangHistory } from "../../src/services/bangCompletions.js";

describe("matchBangHistory", () => {
  // Caller passes commands most-recent-first, already deduped; that order is
  // preserved verbatim in the output.
  const commands = ["git status -s", "git status", "git log", "ls -la"];

  it("prefix-matches case-insensitively, preserving most-recent-first order", () => {
    expect(matchBangHistory(commands, "git ")).toEqual([
      "git status -s",
      "git status",
      "git log",
    ]);
    expect(matchBangHistory(commands, "GIT ")).toEqual([
      "git status -s",
      "git status",
      "git log",
    ]);
  });

  it("excludes the command exactly equal to the current body", () => {
    // "git status" itself would complete to a no-op; drop it, but keep the
    // longer "git status -s" that still extends the body.
    expect(matchBangHistory(commands, "git status")).toEqual(["git status -s"]);
  });

  it("caps at the limit, keeping the earliest (most-recent) matches", () => {
    expect(matchBangHistory(["aa", "ab", "ac", "ad"], "a", 2)).toEqual([
      "aa",
      "ab",
    ]);
  });

  it("returns everything for an empty prefix (nothing is exactly equal)", () => {
    expect(matchBangHistory(["a", "b"], "")).toEqual(["a", "b"]);
  });
});
