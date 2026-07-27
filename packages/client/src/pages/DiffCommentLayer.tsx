import {
  type PatchHunk,
  type PatchLineLocation,
  type ReviewCommentAnchor,
  type ReviewCommentRevision,
  anchorFromPatch,
} from "@yep-anywhere/shared";
import { type RefObject, useCallback, useEffect, useState } from "react";
import { useReviewCommentDraft } from "../hooks/useReviewCommentDraft";
import { ReviewCommentWindow } from "./ReviewCommentWindow";
import type { TranslationFn } from "../i18n";

/**
 * Source-review commenting over a rendered diff (topic:
 * source-review-to-session). A single delegated listener on the diff container
 * maps a click on a server-emitted `[data-diff-line]` node to an anchor via
 * `anchorFromPatch` — never from the DOM's text — and opens a comment window.
 * The add/submit/pending logic is shared with the blame surface via
 * {@link useReviewCommentDraft}; this layer only builds the diff-line anchor.
 * Lines that already carry a draft comment get a tint.
 */

interface OpenComment {
  flatIndex: number;
  location: PatchLineLocation;
  /** Offset from the container's top, to place the window below the line. */
  top: number;
}

export function DiffCommentLayer({
  projectId,
  filePath,
  structuredPatch,
  revision,
  containerRef,
  t,
}: {
  projectId: string;
  filePath: string;
  structuredPatch: PatchHunk[];
  /**
   * Revision to stamp on new comments. Omitted for the working-tree diff (an
   * `uncommitted` anchor is minted at click time); a commit diff passes
   * `{ kind: "sha", sha }` so the comment cites that commit.
   */
  revision?: ReviewCommentRevision;
  containerRef: RefObject<HTMLElement | null>;
  t: TranslationFn;
}) {
  const [open, setOpen] = useState<OpenComment | null>(null);
  const { pending, busy, error, setError, addToReview, submitNow } =
    useReviewCommentDraft(projectId, filePath);

  // Delegated click → anchor. A drag-selection is left alone.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (event: MouseEvent) => {
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      const target = event.target as HTMLElement | null;
      const node = target?.closest("[data-diff-line]");
      if (!node) return;
      const flatIndex = Number(node.getAttribute("data-diff-line"));
      // In side-by-side, the clicked column decides a context line's side:
      // left = old, right = new. Unified diffs have no column → new.
      const contextSide =
        target?.closest("[data-diff-col]")?.getAttribute("data-diff-col") ===
        "old"
          ? "old"
          : "new";
      const location = anchorFromPatch(
        structuredPatch,
        flatIndex,
        undefined,
        contextSide,
      );
      if (!location) return;
      const nodeRect = node.getBoundingClientRect();
      const containerRect = el.getBoundingClientRect();
      setError(null);
      setOpen({
        flatIndex,
        location,
        top: nodeRect.bottom - containerRect.top + el.scrollTop,
      });
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [containerRef, structuredPatch, setError]);

  // Tint every line that carries a pending comment. Idempotent decoration of
  // the same server-emitted nodes the click handler addresses. One linear walk
  // plus a key set; the (oldLine, newLine) pair identifies a line exactly (pure
  // lines carry null on the absent side), so a context-line anchor matches
  // whichever column it was clicked in.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const pendingKeys = new Set(
      pending.map((c) => `${c.anchor.oldLine}:${c.anchor.newLine}`),
    );
    const commented = new Set<number>();
    if (pendingKeys.size > 0) {
      let flat = 0;
      for (const hunk of structuredPatch) {
        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const line of hunk.lines) {
          const prefix = line[0];
          const key =
            prefix === "-"
              ? `${oldLine++}:null`
              : prefix === "+"
                ? `null:${newLine++}`
                : `${oldLine++}:${newLine++}`;
          if (pendingKeys.has(key)) commented.add(flat);
          flat++;
        }
      }
    }
    const nodes = el.querySelectorAll<HTMLElement>("[data-diff-line]");
    for (const node of nodes) {
      const index = Number(node.getAttribute("data-diff-line"));
      node.classList.toggle("has-review-comment", commented.has(index));
    }
  }, [containerRef, structuredPatch, pending]);

  const buildAnchor = useCallback(
    (location: PatchLineLocation): ReviewCommentAnchor => ({
      path: filePath,
      // A commit diff cites its sha; the working-tree diff mints a fresh
      // `uncommitted` anchor timestamped at comment time.
      revision: revision ?? {
        kind: "uncommitted",
        savedAt: new Date().toISOString(),
      },
      side: location.side,
      oldLine: location.oldLine,
      newLine: location.newLine,
      snippet: location.snippet,
      snippetAnchorOffset: location.snippetAnchorOffset,
    }),
    [filePath, revision],
  );

  const onAddToReview = useCallback(
    async (text: string) => {
      if (!open) return;
      if (await addToReview(buildAnchor(open.location), text)) setOpen(null);
    },
    [open, addToReview, buildAnchor],
  );

  const onSubmitNow = useCallback(
    async (text: string) => {
      if (!open) return;
      const outcome = await submitNow(
        buildAnchor(open.location),
        text,
        t("sourceReviewSubmitQueued"),
      );
      if (outcome === "navigated") setOpen(null);
    },
    [open, submitNow, buildAnchor, t],
  );

  if (!open) return null;

  const lineNumber = open.location.newLine ?? open.location.oldLine;
  return (
    <ReviewCommentWindow
      anchorLabel={`${filePath}:${lineNumber ?? "?"}`}
      snippet={open.location.snippet}
      top={open.top}
      busy={busy}
      error={error}
      onCancel={() => setOpen(null)}
      onAddToReview={onAddToReview}
      onSubmitNow={onSubmitNow}
      t={t}
    />
  );
}
