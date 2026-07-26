import type { GitRecentCommit } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { CommitSearchIndex } from "./commitSearchIndex";

function commit(hash: string, subject: string): GitRecentCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    subject,
    authorName: "Dev",
    authorDate: "2026-07-26T00:00:00Z",
  };
}

describe("CommitSearchIndex", () => {
  it("updates cached query results as delta batches arrive", () => {
    const first = commit("a".repeat(40), "metadata match");
    const second = commit("b".repeat(40), "unrelated");
    const index = new CommitSearchIndex();
    index.reset([first, second]);

    expect(index.search("needle")).toEqual([]);
    index.update([{ hash: second.hash, deltaText: "src/x.ts\nadded needle" }]);
    expect(index.search("needle")).toEqual([second]);
    expect(index.search("needle in longer text")).toEqual([]);

    index.update([{ hash: second.hash, deltaText: "needle in longer text" }]);
    expect(index.search("needle in longer text")).toEqual([second]);
    expect(index.search("metadata")).toEqual([first]);
  });
});
