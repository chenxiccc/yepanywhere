import type { GitWorktreeCoverage } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  unionExpandedWorktreeCoverage,
  unionWorktreeCoverage,
} from "../../src/projects/projectWorktreeCoverage.js";

function source(coverage: GitWorktreeCoverage) {
  return { coverage };
}

describe("project worktree coverage", () => {
  it("lets compatibility inventory dominate the shared file scan", () => {
    expect(
      unionWorktreeCoverage([
        source({
          tracked: true,
          untracked: false,
          ignored: false,
          expandedPrefixes: ["src"],
        }),
        source({ tracked: false, untracked: true, ignored: true }),
      ]),
    ).toEqual({ tracked: true, untracked: true, ignored: true });
  });

  it("unions only expanded-prefix subscribers for directory inventory", () => {
    expect(
      unionExpandedWorktreeCoverage([
        source({ tracked: true, untracked: true, ignored: false }),
        source({
          tracked: true,
          untracked: true,
          ignored: false,
          expandedPrefixes: ["src/nested", "src"],
        }),
        source({
          tracked: false,
          untracked: true,
          ignored: true,
          expandedPrefixes: ["notes", "src"],
        }),
      ]),
    ).toEqual({
      tracked: true,
      untracked: true,
      ignored: true,
      expandedPrefixes: ["notes", "src", "src/nested"],
    });
  });

  it("lets a complete filesystem subscriber widen the shared scan policy", () => {
    const sources = [
      source({
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: ["src"],
      }),
      source({
        tracked: true,
        untracked: true,
        ignored: false,
        expandedPrefixes: ["notes"],
        filesystemScan: "complete" as const,
      }),
    ];

    expect(unionWorktreeCoverage(sources)).toEqual({
      tracked: true,
      untracked: true,
      ignored: false,
      expandedPrefixes: ["notes", "src"],
      filesystemScan: "complete",
    });
    expect(unionExpandedWorktreeCoverage(sources)).toEqual({
      tracked: true,
      untracked: true,
      ignored: false,
      expandedPrefixes: ["notes", "src"],
      filesystemScan: "complete",
    });
  });

  it("has no directory inventory without an expanded-prefix subscriber", () => {
    expect(
      unionExpandedWorktreeCoverage([
        source({ tracked: true, untracked: true, ignored: false }),
      ]),
    ).toBeNull();
  });
});
