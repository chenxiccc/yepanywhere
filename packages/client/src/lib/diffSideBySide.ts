import type { PatchHunk } from "@yep-anywhere/shared";

/**
 * Diff view-mode resolution and side-by-side arrangement (topic:
 * source-review-to-session, phase P8). Side-by-side must not be a second
 * server render: it reuses the once-highlighted per-line fragments the server
 * already emits and arranges them client-side from `structuredPatch` (pure
 * data, same source as the anchors). All pure/DOM-only — unit testable.
 */

export type DiffViewMode = "auto" | "unified" | "side-by-side";
export type ResolvedDiffViewMode = "unified" | "side-by-side";

/**
 * Minimum pane width (px) at which two readable code columns fit. `auto`
 * measures the diff pane against this — a content measurement, not a viewport
 * breakpoint ([responsive-layout-gaps]). Sized for two ~65-character columns
 * at the source diff font (~7px/char) plus gutters; 720 proved too eager,
 * picking side-by-side on tablets where each column fit only ~45 characters.
 */
export const MIN_SIDE_BY_SIDE_WIDTH = 1000;

/** Resolve `auto` against the measured pane width; explicit modes pass through. */
export function resolveDiffViewMode(
  mode: DiffViewMode,
  paneWidth: number,
): ResolvedDiffViewMode {
  if (mode === "unified" || mode === "side-by-side") return mode;
  return paneWidth >= MIN_SIDE_BY_SIDE_WIDTH ? "side-by-side" : "unified";
}

/** A hunk header spanning both columns. */
export interface SideBySideHeaderRow {
  type: "header";
  text: string;
}

/**
 * One paired line. `left`/`right` are flat line indices (into the concatenated
 * hunk lines — the same index the server emits as `data-diff-line`), or null
 * for an empty half. A context line uses the same index on both sides.
 */
export interface SideBySideLineRow {
  type: "line";
  left: number | null;
  right: number | null;
}

export type SideBySideRow = SideBySideHeaderRow | SideBySideLineRow;

/**
 * Arrange a structured patch into side-by-side rows: removals align with the
 * additions that replace them (run-for-run), context lines sit on both sides,
 * and unmatched removals/additions leave the opposite half empty.
 */
export function buildSideBySideRows(hunks: PatchHunk[]): SideBySideRow[] {
  const rows: SideBySideRow[] = [];
  let flat = 0;

  for (const hunk of hunks) {
    rows.push({
      type: "header",
      text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });

    let removals: number[] = [];
    let additions: number[] = [];
    const flush = () => {
      const n = Math.max(removals.length, additions.length);
      for (let i = 0; i < n; i++) {
        rows.push({
          type: "line",
          left: removals[i] ?? null,
          right: additions[i] ?? null,
        });
      }
      removals = [];
      additions = [];
    };

    for (const line of hunk.lines) {
      const index = flat++;
      const prefix = line[0];
      if (prefix === "-") {
        removals.push(index);
      } else if (prefix === "+") {
        additions.push(index);
      } else {
        // Context (or unexpected): flush the pending change block first.
        flush();
        rows.push({ type: "line", left: index, right: index });
      }
    }
    flush();
  }

  return rows;
}

/**
 * Extract the server's per-line highlighted fragments from `diffHtml`, keyed by
 * their `data-diff-line` flat index. Uses DOMParser so nested Shiki token spans
 * are handled correctly (no fragile HTML regex). The returned `outerHTML` keeps
 * each line's classes and `data-diff-line`, so the click/tint contract holds in
 * either layout.
 */
export function parseDiffLineFragments(diffHtml: string): Map<number, string> {
  const map = new Map<number, string>();
  if (typeof DOMParser === "undefined") return map;
  const doc = new DOMParser().parseFromString(diffHtml, "text/html");
  for (const el of doc.querySelectorAll("[data-diff-line]")) {
    const index = Number(el.getAttribute("data-diff-line"));
    if (Number.isInteger(index)) map.set(index, el.outerHTML);
  }
  return map;
}
