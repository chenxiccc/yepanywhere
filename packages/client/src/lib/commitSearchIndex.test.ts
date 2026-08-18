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
  it("returns the actual metadata field that matched", () => {
    const first = commit("a".repeat(40), "metadata Needle");
    const index = new CommitSearchIndex();
    index.reset([first]);

    expect(index.search("needle")).toEqual([
      {
        commit: first,
        match: { field: "subject", text: "metadata Needle" },
      },
    ]);
    expect(index.search("dev")).toEqual([
      {
        commit: first,
        match: { field: "author", text: "Dev" },
      },
    ]);
  });

  it("returns the changed path or text line that matched", () => {
    const first = commit("a".repeat(40), "metadata match");
    const second = commit("b".repeat(40), "unrelated");
    const index = new CommitSearchIndex();
    index.reset([first, second]);

    expect(index.search("needle")).toEqual([]);
    index.update([
      {
        hash: second.hash,
        deltaText: "src/x.ts\nadded Needle in longer text\nsrc/y.ts",
      },
    ]);
    expect(index.search("needle")).toEqual([
      {
        commit: second,
        match: { field: "change", text: "added Needle in longer text" },
      },
    ]);
    expect(index.search("needle in longer text")).toEqual([
      {
        commit: second,
        match: { field: "change", text: "added Needle in longer text" },
      },
    ]);

    index.update([{ hash: second.hash, deltaText: "src/y.ts" }]);
    expect(index.search("needle")).toEqual([]);
    expect(index.search("metadata")).toEqual([
      {
        commit: first,
        match: { field: "subject", text: "metadata match" },
      },
    ]);
  });
});
