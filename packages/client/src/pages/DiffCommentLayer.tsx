import {
  type PatchHunk,
  type PatchLineLocation,
  type ReviewCommentAnchor,
  type ReviewNewSessionOptions,
  type ReviewCommentRevision,
  anchorFromPatch,
} from "@yep-anywhere/shared";
import { type RefObject, useCallback, useEffect, useState } from "react";
import {
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { useReviewCommentDraft } from "../hooks/useReviewCommentDraft";
import { writeClipboardText } from "../lib/clipboard";
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
  /** Immutable click-time anchor; live diff refreshes never rewrite it. */
  anchor: ReviewCommentAnchor;
  /** Offset from the container's top, to place the window below the line. */
  top: number;
}

interface DiffLineTarget {
  flatIndex: number;
  contextSide: "old" | "new";
  top: number;
}

export function DiffCommentLayer({
  projectId,
  filePath,
  structuredPatch,
  revision,
  containerRef,
  onOpenChange,
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
  /** Keeps the owning source view alive while the user owns this editor. */
  onOpenChange?: (open: boolean) => void;
  t: TranslationFn;
}) {
  const [open, setOpen] = useState<OpenComment | null>(null);
  const [activeLine, setActiveLine] = useState<DiffLineTarget | null>(null);
  const {
    menu: lineMenu,
    openAt: openLineMenuAt,
    openFromButton: openLineMenuFromButton,
    beginLongPressAt: beginLineLongPressAt,
    moveLongPressAt: moveLineLongPressAt,
    endLongPress: endLineLongPress,
    consumeLongPressClick,
  } = useSourceContextMenu(t);
  const {
    pending,
    defaultSession,
    busy,
    error,
    setError,
    addToReview,
    submitNow,
  } = useReviewCommentDraft(projectId, filePath);

  const buildAnchor = useCallback(
    (location: PatchLineLocation): ReviewCommentAnchor => ({
      path: filePath,
      // A commit diff cites its sha; the working-tree diff mints a fresh
      // `uncommitted` anchor timestamped at click time.
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

  const resolveLineTarget = useCallback(
    (
      target: EventTarget | null,
    ): {
      node: HTMLElement;
      target: DiffLineTarget;
      location: PatchLineLocation;
    } | null => {
      const el = containerRef.current;
      if (!el || !(target instanceof HTMLElement)) return null;
      const node = target.closest<HTMLElement>("[data-diff-line]");
      if (!node || !el.contains(node)) return null;
      const flatIndex = Number(node.getAttribute("data-diff-line"));
      const contextSide =
        target.closest("[data-diff-col]")?.getAttribute("data-diff-col") ===
        "old"
          ? "old"
          : "new";
      const location = anchorFromPatch(
        structuredPatch,
        flatIndex,
        undefined,
        contextSide,
      );
      if (!location) return null;
      const nodeRect = node.getBoundingClientRect();
      const containerRect = el.getBoundingClientRect();
      return {
        node,
        target: {
          flatIndex,
          contextSide,
          top: nodeRect.top - containerRect.top + el.scrollTop,
        },
        location,
      };
    },
    [containerRef, structuredPatch],
  );

  const openComment = useCallback(
    (
      target: DiffLineTarget,
      location: PatchLineLocation,
      node: HTMLElement,
    ) => {
      const el = containerRef.current;
      if (!el) return;
      const nodeRect = node.getBoundingClientRect();
      const containerRect = el.getBoundingClientRect();
      setError(null);
      setActiveLine(target);
      setOpen({
        anchor: buildAnchor(location),
        top: nodeRect.bottom - containerRect.top + el.scrollTop,
      });
    },
    [buildAnchor, containerRef, setError],
  );

  const activateLine = useCallback((target: DiffLineTarget) => {
    setActiveLine((current) =>
      current?.flatIndex === target.flatIndex &&
      current.contextSide === target.contextSide &&
      current.top === target.top
        ? current
        : target,
    );
  }, []);

  const lineMenuActions = useCallback(
    (
      target: DiffLineTarget,
      location: PatchLineLocation,
      node: HTMLElement,
    ): SourceContextMenuAction[] => {
      const clickedLine =
        location.snippet.split("\n")[location.snippetAnchorOffset] ?? "";
      const lineNumber = location.newLine ?? location.oldLine;
      return [
        {
          label: t("sourceCommentOnLine"),
          onSelect: () => openComment(target, location, node),
        },
        {
          label: t("sourceCopyLine"),
          separatorBefore: true,
          onSelect: () => {
            void writeClipboardText(clickedLine);
          },
        },
        {
          label: t("sourceCopyPathLine"),
          onSelect: () => {
            void writeClipboardText(
              lineNumber ? `${filePath}:${lineNumber}` : filePath,
            );
          },
        },
      ];
    },
    [filePath, openComment, t],
  );

  useEffect(() => {
    onOpenChange?.(open !== null);
    return () => {
      if (open) onOpenChange?.(false);
    };
  }, [onOpenChange, open]);

  // Delegated pointer/keyboard handling keeps server-emitted diff markup as
  // presentation while every line exposes the same click and action-menu path.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onClick = (event: MouseEvent) => {
      if (consumeLongPressClick()) return;
      if (!(window.getSelection()?.isCollapsed ?? true)) return;
      const resolved = resolveLineTarget(event.target);
      if (!resolved) return;
      openComment(resolved.target, resolved.location, resolved.node);
    };
    const onContextMenu = (event: MouseEvent) => {
      const resolved = resolveLineTarget(event.target);
      if (!resolved) return;
      event.preventDefault();
      event.stopPropagation();
      activateLine(resolved.target);
      openLineMenuAt(
        event.clientX,
        event.clientY,
        resolved.node,
        lineMenuActions(resolved.target, resolved.location, resolved.node),
      );
    };
    const onPointerDown = (event: globalThis.PointerEvent) => {
      const resolved = resolveLineTarget(event.target);
      if (!resolved) return;
      activateLine(resolved.target);
      beginLineLongPressAt(
        event,
        resolved.node,
        lineMenuActions(resolved.target, resolved.location, resolved.node),
      );
    };
    const onPointerMove = (event: globalThis.PointerEvent) => {
      moveLineLongPressAt(event);
      const resolved = resolveLineTarget(event.target);
      if (resolved) activateLine(resolved.target);
    };
    const onPointerEnd = () => endLineLongPress();
    const onPointerLeave = () => {
      endLineLongPress();
      setActiveLine(null);
    };
    const onFocusIn = (event: FocusEvent) => {
      const resolved = resolveLineTarget(event.target);
      if (resolved) activateLine(resolved.target);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const resolved = resolveLineTarget(event.target);
      if (!resolved) return;
      if (
        event.key === "ContextMenu" ||
        (event.shiftKey && event.key === "F10")
      ) {
        event.preventDefault();
        event.stopPropagation();
        const rect = resolved.node.getBoundingClientRect();
        openLineMenuAt(
          rect.left + Math.min(32, rect.width / 2),
          rect.bottom,
          resolved.node,
          lineMenuActions(resolved.target, resolved.location, resolved.node),
        );
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openComment(resolved.target, resolved.location, resolved.node);
        return;
      }
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      const nodes = Array.from(
        el.querySelectorAll<HTMLElement>("[data-diff-line]"),
      );
      const index = nodes.indexOf(resolved.node);
      const next = nodes[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (!next) return;
      event.preventDefault();
      next.focus();
    };
    el.addEventListener("click", onClick);
    el.addEventListener("contextmenu", onContextMenu);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerEnd);
    el.addEventListener("pointercancel", onPointerEnd);
    el.addEventListener("pointerleave", onPointerLeave);
    el.addEventListener("focusin", onFocusIn);
    el.addEventListener("keydown", onKeyDown);
    return () => {
      el.removeEventListener("click", onClick);
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerEnd);
      el.removeEventListener("pointercancel", onPointerEnd);
      el.removeEventListener("pointerleave", onPointerLeave);
      el.removeEventListener("focusin", onFocusIn);
      el.removeEventListener("keydown", onKeyDown);
    };
  }, [
    activateLine,
    beginLineLongPressAt,
    consumeLongPressClick,
    containerRef,
    endLineLongPress,
    lineMenuActions,
    moveLineLongPressAt,
    openComment,
    openLineMenuAt,
    resolveLineTarget,
  ]);

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
    const decorate = () => {
      const nodes = el.querySelectorAll<HTMLElement>("[data-diff-line]");
      for (const node of nodes) {
        const index = Number(node.getAttribute("data-diff-line"));
        node.classList.toggle("has-review-comment", commented.has(index));
        node.tabIndex = 0;
        node.setAttribute("aria-label", t("sourceDiffLineActions"));
      }
    };
    decorate();
    const observer = new MutationObserver(decorate);
    observer.observe(el, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [containerRef, structuredPatch, pending, t]);

  const onAddToReview = useCallback(
    async (text: string) => {
      if (!open) return;
      if (await addToReview(open.anchor, text)) setOpen(null);
    },
    [open, addToReview],
  );

  const onSubmit = useCallback(
    async (
      text: string,
      target: "new" | string,
      newSession?: ReviewNewSessionOptions,
    ) => {
      if (!open) return;
      const outcome = await submitNow(
        open.anchor,
        text,
        target,
        t("sourceReviewSubmitQueued"),
        newSession,
      );
      if (outcome === "navigated") setOpen(null);
    },
    [open, submitNow, t],
  );

  return (
    <>
      {activeLine && (
        <button
          type="button"
          className="source-diff-line-menu-trigger"
          style={{ top: activeLine.top }}
          aria-label={t("sourceMoreActions")}
          title={t("sourceMoreActions")}
          onClick={(event) => {
            const el = containerRef.current;
            const nodes = el?.querySelectorAll<HTMLElement>(
              `[data-diff-line="${activeLine.flatIndex}"]`,
            );
            const node =
              Array.from(nodes ?? []).find(
                (candidate) =>
                  (candidate
                    .closest("[data-diff-col]")
                    ?.getAttribute("data-diff-col") ?? "new") ===
                  activeLine.contextSide,
              ) ?? nodes?.[0];
            if (!node) return;
            const location = anchorFromPatch(
              structuredPatch,
              activeLine.flatIndex,
              undefined,
              activeLine.contextSide,
            );
            if (!location) return;
            openLineMenuFromButton(
              event,
              lineMenuActions(activeLine, location, node),
            );
          }}
        >
          ⋯
        </button>
      )}
      {lineMenu}
      {open &&
        (() => {
          const lineNumber = open.anchor.newLine ?? open.anchor.oldLine;
          return (
            <ReviewCommentWindow
              anchorLabel={`${filePath}:${lineNumber ?? "?"}`}
              snippet={open.anchor.snippet}
              top={open.top}
              busy={busy}
              error={error}
              onCancel={() => setOpen(null)}
              onAddToReview={onAddToReview}
              defaultSession={defaultSession}
              onSubmitToDefault={
                defaultSession
                  ? (text) => onSubmit(text, defaultSession.id)
                  : null
              }
              onSubmitToNew={(text) =>
                onSubmit(text, "new", defaultSession?.newSession)
              }
              t={t}
            />
          );
        })()}
    </>
  );
}
