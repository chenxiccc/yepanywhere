import type {
  PatchHunk,
  PatchLineLocation,
  ReviewCommentAnchor,
  ReviewNewSessionOptions,
} from "@yep-anywhere/shared";
import { useCallback, useLayoutEffect, useState } from "react";
import {
  type SourceContextMenuAction,
  useSourceContextMenu,
} from "../components/SourceContextMenu";
import { useReviewCommentDraft } from "../hooks/useReviewCommentDraft";
import { writeClipboardText } from "../lib/clipboard";
import { ReviewCommentWindow } from "./ReviewCommentWindow";
import {
  type DiffCommentRevisions,
  type DiffLineTarget,
  type ResolvedDiffLineTarget,
  useDiffLineInteractions,
} from "./useDiffLineInteractions";
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

export function DiffCommentLayer({
  projectId,
  filePath,
  structuredPatch,
  revisions,
  container,
  onOpenChange,
  t,
}: {
  projectId: string;
  filePath: string;
  structuredPatch: PatchHunk[];
  /** Revision containing each projection side; omitted means working tree. */
  revisions?: DiffCommentRevisions;
  container: HTMLElement;
  /** Keeps the owning source view alive while the user owns this editor. */
  onOpenChange?: (open: boolean) => void;
  t: TranslationFn;
}) {
  const [open, setOpen] = useState<OpenComment | null>(null);
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
      // Comparison sides cite their respective endpoints. A working-tree diff
      // mints a fresh `uncommitted` anchor timestamped at click time.
      revision: revisions?.[location.side] ?? {
        kind: "uncommitted",
        savedAt: new Date().toISOString(),
      },
      side: location.side,
      oldLine: location.oldLine,
      newLine: location.newLine,
      snippet: location.snippet,
      snippetAnchorOffset: location.snippetAnchorOffset,
    }),
    [filePath, revisions],
  );

  const openComment = useCallback(
    ({ location, node }: ResolvedDiffLineTarget) => {
      const nodeRect = node.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      setError(null);
      setOpen({
        anchor: buildAnchor(location),
        top: nodeRect.bottom - containerRect.top + container.scrollTop,
      });
    },
    [buildAnchor, container, setError],
  );

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
          onSelect: () => openComment({ target, location, node }),
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

  const openLineMenu = useCallback(
    (
      resolved: ResolvedDiffLineTarget,
      point: { x: number; y: number },
    ) => {
      openLineMenuAt(
        point.x,
        point.y,
        resolved.node,
        lineMenuActions(
          resolved.target,
          resolved.location,
          resolved.node,
        ),
      );
    },
    [lineMenuActions, openLineMenuAt],
  );

  const beginLineLongPress = useCallback(
    (
      resolved: ResolvedDiffLineTarget,
      event: globalThis.PointerEvent,
    ) => {
      beginLineLongPressAt(
        event,
        resolved.node,
        lineMenuActions(
          resolved.target,
          resolved.location,
          resolved.node,
        ),
      );
    },
    [beginLineLongPressAt, lineMenuActions],
  );

  const { activeLine, resolveActiveLine } = useDiffLineInteractions({
    container,
    structuredPatch,
    pending,
    revisions,
    consumeLongPressClick,
    onOpenComment: openComment,
    onOpenMenu: openLineMenu,
    onBeginLongPress: beginLineLongPress,
    onMoveLongPress: moveLineLongPressAt,
    onEndLongPress: endLineLongPress,
    t,
  });

  useLayoutEffect(() => {
    onOpenChange?.(open !== null);
    return () => {
      if (open) onOpenChange?.(false);
    };
  }, [onOpenChange, open]);

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
            const resolved = resolveActiveLine();
            if (!resolved) return;
            openLineMenuFromButton(
              event,
              lineMenuActions(
                resolved.target,
                resolved.location,
                resolved.node,
              ),
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
