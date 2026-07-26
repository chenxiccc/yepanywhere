// @vitest-environment jsdom

import type { PatchHunk } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  MIN_SIDE_BY_SIDE_WIDTH,
  buildSideBySideRows,
  parseDiffLineFragments,
  resolveDiffViewMode,
} from "./diffSideBySide";

describe("resolveDiffViewMode", () => {
  it("passes explicit modes through regardless of width", () => {
    expect(resolveDiffViewMode("unified", 5000)).toBe("unified");
    expect(resolveDiffViewMode("side-by-side", 100)).toBe("side-by-side");
  });

  it("auto resolves unified below the threshold and side-by-side at/above", () => {
    expect(resolveDiffViewMode("auto", MIN_SIDE_BY_SIDE_WIDTH - 1)).toBe(
      "unified",
    );
    expect(resolveDiffViewMode("auto", MIN_SIDE_BY_SIDE_WIDTH)).toBe(
      "side-by-side",
    );
  });
});

describe("buildSideBySideRows", () => {
  it("pairs removals with additions and keeps context on both sides", () => {
    // 0:" a" 1:"-b" 2:"-c" 3:"+B" 4:"+C" 5:"+D" 6:" e"
    const hunks: PatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 4,
        newStart: 1,
        newLines: 5,
        lines: [" a", "-b", "-c", "+B", "+C", "+D", " e"],
      },
    ];
    const rows = buildSideBySideRows(hunks);
    expect(rows[0]).toMatchObject({ type: "header" });
    expect(rows[1]).toEqual({ type: "line", left: 0, right: 0 });
    expect(rows[2]).toEqual({ type: "line", left: 1, right: 3 });
    expect(rows[3]).toEqual({ type: "line", left: 2, right: 4 });
    expect(rows[4]).toEqual({ type: "line", left: null, right: 5 });
    expect(rows[5]).toEqual({ type: "line", left: 6, right: 6 });
  });

  it("keeps flat indices continuous across hunks", () => {
    const hunks: PatchHunk[] = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-a", "+b"],
      },
      { oldStart: 9, oldLines: 1, newStart: 9, newLines: 1, lines: [" c"] },
    ];
    const lineRows = buildSideBySideRows(hunks).filter(
      (row) => row.type === "line",
    );
    expect(lineRows[0]).toEqual({ type: "line", left: 0, right: 1 });
    expect(lineRows[1]).toEqual({ type: "line", left: 2, right: 2 });
  });
});

describe("parseDiffLineFragments", () => {
  it("maps each data-diff-line index to its outer HTML, ignoring headers", () => {
    const html =
      `<pre class="shiki"><code>` +
      `<span class="line line-hunk">@@</span>\n` +
      `<span class="line line-deleted" data-diff-line="0">-x</span>\n` +
      `<span class="line line-inserted" data-diff-line="1"><span style="color:red">+y</span></span>` +
      `</code></pre>`;
    const map = parseDiffLineFragments(html);
    expect(map.size).toBe(2);
    expect(map.get(0)).toContain('data-diff-line="0"');
    expect(map.get(1)).toContain("+y");
    expect([...map.keys()]).toEqual([0, 1]);
  });
});
