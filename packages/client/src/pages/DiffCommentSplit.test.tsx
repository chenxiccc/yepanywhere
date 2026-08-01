// @vitest-environment jsdom

import type { PatchHunk } from "@yep-anywhere/shared";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SideBySideDiff } from "./SideBySideDiff";
import { UnifiedDiff } from "./UnifiedDiff";

const PATCH: PatchHunk[] = [
  {
    oldStart: 1,
    oldLines: 3,
    newStart: 1,
    newLines: 3,
    lines: [" a", "-b", "+B", " c"],
  },
];

const DIFF_HTML =
  `<pre class="shiki"><code>` +
  `<span class="line line-context" data-diff-line="0"> a</span>` +
  `<span class="line line-deleted" data-diff-line="1">-b</span>` +
  `<span class="line line-inserted" data-diff-line="2">+B</span>` +
  `<span class="line line-context" data-diff-line="3"> c</span>` +
  `</code></pre>`;

describe("diff comment splits", () => {
  afterEach(cleanup);

  it("keeps the selected unified row above the editor", () => {
    render(
      <UnifiedDiff
        diffHtml={DIFF_HTML}
        structuredPatch={PATCH}
        splitAfterLine={2}
        editor={<textarea aria-label="comment" />}
      />,
    );

    const before = document.querySelector("[data-review-comment-before]");
    const after = document.querySelector("[data-review-comment-after]");
    expect(before?.querySelector('[data-diff-line="2"]')).toBeTruthy();
    expect(before?.querySelector('[data-diff-line="3"]')).toBeNull();
    expect(after?.querySelector('[data-diff-line="3"]')).toBeTruthy();
  });

  it("keeps the selected side-by-side row above the editor", () => {
    render(
      <SideBySideDiff
        diffHtml={DIFF_HTML}
        structuredPatch={PATCH}
        splitAfterLine={2}
        editor={<textarea aria-label="comment" />}
      />,
    );

    const before = document.querySelector("[data-review-comment-before]");
    const after = document.querySelector("[data-review-comment-after]");
    expect(before?.querySelector('[data-diff-line="2"]')).toBeTruthy();
    expect(before?.querySelector('[data-diff-line="3"]')).toBeNull();
    expect(after?.querySelector('[data-diff-line="3"]')).toBeTruthy();
  });
});
