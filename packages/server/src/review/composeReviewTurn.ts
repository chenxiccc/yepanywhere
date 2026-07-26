/**
 * Compose the seeded review turn (topic: source-review-to-session).
 *
 * The delivered turn is a short prompt: it names what this is, tells the agent
 * to address each comment and report per-comment dispositions, and — crucially
 * — instructs it to read current file state rather than trust the quoted
 * snippets. The structured comments travel by reference in the project-local
 * `.yep/review-comments.json`; each comment also carries a small inline snippet
 * for human readability and immediate context.
 *
 * A SHA is cited only when relocation failed (the line is gone) or the comment
 * is on the removed side — the lean-turn rule. A successfully relocated line
 * gives path + current line + snippet; the agent can blame it if it wants
 * provenance. Pure string composition — no I/O.
 */

import type { ReviewComment } from "@yep-anywhere/shared";
import type { AnchorRelocation } from "./relocateAnchors.js";

export interface ComposeReviewTurnInput {
  comments: ReviewComment[];
  /** Relocation per comment id, from {@link relocateAnchors} at submit time. */
  relocations: Map<string, AnchorRelocation>;
  /** Repo-relative path of the review file the prompt references. */
  reviewFileRelPath: string;
  /** True for a follow-up turn to an existing review session. */
  followUp?: boolean;
}

export const READ_CURRENT_STATE_INSTRUCTION =
  "Read the current file state for each referenced line rather than trusting " +
  "the quoted snippets — the tree may have changed since these comments were " +
  "written.";

export function composeReviewTurn(input: ComposeReviewTurnInput): string {
  const { comments, relocations, reviewFileRelPath, followUp } = input;
  const n = comments.length;
  const out: string[] = [];

  out.push(followUp ? "# Source review — follow-up" : "# Source review");
  out.push("");
  out.push(
    `${followUp ? "A further" : "A"} source review: ${n} comment${
      n === 1 ? "" : "s"
    } left on diff lines. Address each one and report a per-comment disposition ` +
      "(done / won't-fix / question). The full structured review is in " +
      `\`${reviewFileRelPath}\`.`,
  );
  out.push("");
  out.push(READ_CURRENT_STATE_INSTRUCTION);
  out.push("");

  // Group by file path, preserving first-seen order.
  const byPath = new Map<string, ReviewComment[]>();
  for (const comment of comments) {
    const group = byPath.get(comment.anchor.path) ?? [];
    group.push(comment);
    byPath.set(comment.anchor.path, group);
  }

  for (const [path, group] of byPath) {
    out.push(`## ${path}`);
    out.push("");
    for (const comment of group) {
      out.push(renderComment(comment, relocations.get(comment.id)));
      out.push("");
    }
  }

  return `${out.join("\n").trimEnd()}\n`;
}

function renderComment(
  comment: ReviewComment,
  relocation: AnchorRelocation | undefined,
): string {
  const anchor = comment.anchor;
  const lines: string[] = [];

  if (relocation?.status === "relocated") {
    let location = `${anchor.path}:${relocation.line}`;
    // "From X to Y" framing for a diff comment: carry both the old and new
    // line the change spanned.
    if (anchor.oldLine !== null && anchor.newLine !== null) {
      location += ` (old L${anchor.oldLine} → new L${anchor.newLine})`;
    }
    lines.push(`- **${location}** — ${comment.text}`);
    lines.push(fence(relocation.snippet));
    return lines.join("\n");
  }

  // Gone: relocation failed, or a removed (`-`-side) line.
  const citeSha =
    relocation?.status === "gone"
      ? relocation.citeSha
      : anchor.revision.kind === "sha"
        ? anchor.revision.sha
        : null;
  const where =
    anchor.oldLine !== null ? `old L${anchor.oldLine}` : `L${anchor.newLine}`;
  const provenance = citeSha
    ? `as of ${citeSha}; line no longer in the current tree`
    : "removed; not in the current tree";
  lines.push(
    `- **${anchor.path} — ${where} (${provenance})** — ${comment.text}`,
  );
  lines.push(fence(relocation?.snippet ?? anchor.snippet));
  return lines.join("\n");
}

function fence(snippet: string): string {
  return `\`\`\`\n${snippet}\n\`\`\``;
}
