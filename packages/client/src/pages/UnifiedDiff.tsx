import type { PatchHunk } from "@yep-anywhere/shared";
import { memo, type ReactNode, useMemo } from "react";
import { parseDiffLineFragments } from "../lib/diffSideBySide";
import { ReviewCommentSplitLayout } from "./ReviewCommentSplitLayout";

type UnifiedRow =
  | { type: "header"; text: string }
  | { type: "line"; flatIndex: number; text: string };

export const UnifiedDiff = memo(function UnifiedDiff({
  diffHtml,
  structuredPatch,
  splitAfterLine,
  editor = null,
}: {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  splitAfterLine?: number;
  editor?: ReactNode;
}) {
  const fragments = useMemo(() => parseDiffLineFragments(diffHtml), [diffHtml]);
  const rows = useMemo(
    () => buildUnifiedRows(structuredPatch),
    [structuredPatch],
  );
  const splitIndex =
    splitAfterLine === undefined
      ? -1
      : rows.findIndex(
          (row) => row.type === "line" && row.flatIndex === splitAfterLine,
        );

  if (splitIndex < 0 || !editor) {
    return <UnifiedRows rows={rows} fragments={fragments} />;
  }

  return (
    <ReviewCommentSplitLayout
      before={
        <UnifiedRows
          rows={rows.slice(0, splitIndex + 1)}
          fragments={fragments}
        />
      }
      editor={editor}
      after={
        <UnifiedRows rows={rows.slice(splitIndex + 1)} fragments={fragments} />
      }
    />
  );
});

function buildUnifiedRows(hunks: PatchHunk[]): UnifiedRow[] {
  const rows: UnifiedRow[] = [];
  let flatIndex = 0;
  for (const hunk of hunks) {
    rows.push({
      type: "header",
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    for (const line of hunk.lines) {
      rows.push({
        type: "line",
        flatIndex,
        text: line,
      });
      flatIndex += 1;
    }
  }
  return rows;
}

function UnifiedRows({
  rows,
  fragments,
}: {
  rows: UnifiedRow[];
  fragments: Map<number, string>;
}) {
  const html = rows
    .map((row) => {
      if (row.type === "header") {
        return `<span class="line line-hunk">${escapeText(row.text)}</span>`;
      }
      return (
        fragments.get(row.flatIndex) ??
        `<span class="${fallbackClassName(row.text)}" data-diff-line="${row.flatIndex}"><span class="diff-prefix">${escapeText(row.text[0] ?? " ")}</span>${escapeText(row.text.slice(1))}</span>`
      );
    })
    .join("");
  return (
    <div
      className="highlighted-diff"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: server-highlighted diff rows
      dangerouslySetInnerHTML={{
        __html: `<pre class="shiki"><code>${html}</code></pre>`,
      }}
    />
  );
}

function fallbackClassName(line: string): string {
  return line[0] === "-"
    ? "line line-deleted"
    : line[0] === "+"
      ? "line line-inserted"
      : "line line-context";
}

function escapeText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
