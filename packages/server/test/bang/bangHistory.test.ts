/**
 * Global bang command-history matching for Tab completion: prefix-match prior
 * whole `!!` command lines against the current body, most-recent-first,
 * excluding the exact current body. Contract: topics/bang-commands.md.
 */

import { describe, expect, it } from "vitest";
import {
  BangHistoryIndex,
  matchBangHistory,
} from "../../src/services/bangCompletions.js";

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

describe("BangHistoryIndex", () => {
  it("agrees with matchBangHistory on both the bucketed and fallback paths", () => {
    // 3+ commands sharing "git " exercises an indexed bucket
    // (HISTORY_INDEX_MIN_OCCUPANCY = 3); "ls -la" stays under the occupancy
    // floor, so matching it walks the full-corpus fallback.
    const commands = ["git status -s", "git status", "git log", "ls -la"];
    const index = new BangHistoryIndex(commands);
    for (const prefix of ["git ", "GIT S", "git status", "ls", "l", "zzz"]) {
      expect(index.match(prefix)).toEqual(matchBangHistory(commands, prefix));
    }
  });

  it("matches needles longer than the indexed prefix cap via the deepest bucket", () => {
    const shared = "git commit --amend --no-edit ";
    const commands = [`${shared}A`, `${shared}B`, `${shared}C`];
    const index = new BangHistoryIndex(commands);
    expect(index.match(`${shared}b`)).toEqual([`${shared}B`]);
    expect(index.match(shared)).toEqual(commands);
  });

  it("preserves most-recent-first order and the limit inside a bucket", () => {
    const commands = ["aa", "ab", "ac", "ad"];
    const index = new BangHistoryIndex(commands);
    expect(index.match("a", 2)).toEqual(["aa", "ab"]);
  });
});
