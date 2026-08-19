import type { PatchHunk } from "@yep-anywhere/shared";
import { Fragment, memo, type ReactNode, useMemo } from "react";
import { parseDiffLineFragments } from "../lib/diffSideBySide";
import { ReviewCommentSplitLayout } from "./ReviewCommentSplitLayout";
import styles from "./UnifiedDiff.module.css";

type UnifiedRow =
  | { type: "header"; text: string }
  | { type: "line"; flatIndex: number; text: string };

export const CHANGED_DIFF_LINE_SELECTOR =
  ".line-deleted, .line-inserted, .diff-removed, .diff-added, .fixed-font-diff-removed, .fixed-font-diff-added";

export const UnifiedDiff = memo(function UnifiedDiff({
  diffHtml,
  structuredPatch,
  splitAfterLine,
  editor = null,
  plain = false,
}: {
  diffHtml: string;
  structuredPatch: PatchHunk[];
  splitAfterLine?: number;
  editor?: ReactNode;
  plain?: boolean;
}) {
  const fragments = useMemo(
    () =>
      plain ? new Map<number, string>() : parseDiffLineFragments(diffHtml),
    [diffHtml, plain],
  );
  const rows = useMemo(
    () => (plain ? [] : buildUnifiedRows(structuredPatch)),
    [plain, structuredPatch],
  );
  if (plain) {
    return <PlainUnifiedRows hunks={structuredPatch} />;
  }

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

function PlainUnifiedRows({ hunks }: { hunks: PatchHunk[] }) {
  return (
    <div className={styles.plain} data-diff-rendering="plain">
      <pre>
        <code>
          {hunks.map((hunk, index) => (
            <Fragment key={`${hunk.oldStart}:${hunk.newStart}:${index}`}>
              <span className={`${styles.hunkHeader} line-hunk`}>
                {`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`}
              </span>
              {"\n"}
              {hunk.lines.join("\n")}
              {index + 1 < hunks.length ? "\n" : ""}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}

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
