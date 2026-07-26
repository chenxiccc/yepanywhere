import type { PatchHunk } from "@yep-anywhere/shared";
import { memo, useMemo } from "react";
import {
  buildSideBySideRows,
  parseDiffLineFragments,
} from "../lib/diffSideBySide";

/**
 * Side-by-side diff (topic: source-review-to-session, P8). The server already
 * highlighted every line once; this arranges those per-line fragments into two
 * columns from `structuredPatch` — old (`-`) on the left, new (`+`) on the
 * right — rather than asking the server to render a second time. Each cell
 * keeps the line's `data-diff-line` (so the comment click/tint contract holds)
 * and carries `data-diff-col`, so a left-column click anchors the old side and
 * a right-column click the new side.
 */
export const SideBySideDiff = memo(function SideBySideDiff({
  diffHtml,
  structuredPatch,
}: {
  diffHtml: string;
  structuredPatch: PatchHunk[];
}) {
  const fragments = useMemo(() => parseDiffLineFragments(diffHtml), [diffHtml]);
  const rows = useMemo(
    () => buildSideBySideRows(structuredPatch),
    [structuredPatch],
  );

  return (
    <div className="side-by-side-diff">
      {rows.map((row, index) => {
        if (row.type === "header") {
          return (
            <div
              key={`h-${index}`}
              className="sbs-header highlighted-diff"
              // biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted diff
              dangerouslySetInnerHTML={{
                __html: `<pre class="shiki"><code><span class="line line-hunk">${escapeText(
                  row.text,
                )}</span></code></pre>`,
              }}
            />
          );
        }
        return (
          <div key={`r-${index}`} className="sbs-row">
            <SbsCell col="old" html={cellHtml(fragments, row.left)} />
            <SbsCell col="new" html={cellHtml(fragments, row.right)} />
          </div>
        );
      })}
    </div>
  );
});

function cellHtml(
  fragments: Map<number, string>,
  index: number | null,
): string | null {
  if (index === null) return null;
  return fragments.get(index) ?? null;
}

function SbsCell({ col, html }: { col: "old" | "new"; html: string | null }) {
  if (html === null) {
    return <div className="sbs-cell sbs-empty" />;
  }
  return (
    <div
      className="sbs-cell highlighted-diff"
      data-diff-col={col}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted diff
      dangerouslySetInnerHTML={{
        __html: `<pre class="shiki"><code>${html}</code></pre>`,
      }}
    />
  );
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
