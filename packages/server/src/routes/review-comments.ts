/**
 * Source-review draft-comment CRUD (topic: source-review-to-session).
 *
 * The client leaves line comments that accumulate as server-owned drafts;
 * these routes are the create/read/update/delete surface over
 * {@link ReviewCommentService}. Preview and submit (stages P5) land here later
 * as sibling routes — kept out of the 1200-line git-status.ts by design.
 *
 * Mounted at `/api/projects`, so paths are `/:projectId/review/comments...`.
 */

import {
  MAX_REVIEW_COMMENT_TEXT_LENGTH,
  isUrlProjectId,
  parseReviewCommentAnchor,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import { ReviewCommentService } from "../review/ReviewCommentService.js";
import { composeReviewTurn } from "../review/composeReviewTurn.js";
import {
  type AnchorRelocation,
  relocateAnchors,
} from "../review/relocateAnchors.js";
import type { ReviewSessionLauncher } from "../review/reviewSessionLauncher.js";

/** Repo-relative path of the drafts file the seeded turn references. */
const REVIEW_COMMENTS_REL_PATH = ".yep/review-comments.json";

export interface ReviewCommentsDeps {
  scanner: ProjectScanner;
  /** Injectable for tests (stub clock/id); a fresh service by default. */
  service?: ReviewCommentService;
  /** Launches/continues the review session on submit. Absent → submit 501s. */
  launcher?: ReviewSessionLauncher;
}

export function createReviewCommentsRoutes(deps: ReviewCommentsDeps): Hono {
  const routes = new Hono();
  const service = deps.service ?? new ReviewCommentService();

  /** Resolve `:projectId` → project path, or respond with the error status. */
  async function resolveProjectPath(
    projectId: string,
  ): Promise<{ path: string } | { error: string; status: 400 | 404 }> {
    if (!isUrlProjectId(projectId)) {
      return { error: "Invalid project ID format", status: 400 };
    }
    const project = await deps.scanner.getProject(projectId);
    if (!project) return { error: "Project not found", status: 404 };
    return { path: project.path };
  }

  // GET /:projectId/review/comments — full draft store (comments + batches).
  routes.get("/:projectId/review/comments", async (c) => {
    const resolved = await resolveProjectPath(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const file = await service.getFile(resolved.path);
    const pendingCount = file.comments.filter(
      (comment) => comment.status === "pending",
    ).length;
    return c.json({ ...file, pendingCount });
  });

  // POST /:projectId/review/comments { anchor, text } — create a pending draft.
  routes.post("/:projectId/review/comments", async (c) => {
    const resolved = await resolveProjectPath(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const anchor = parseReviewCommentAnchor(body.anchor);
    if (!anchor) return c.json({ error: "Invalid comment anchor" }, 400);

    const textError = validateText(body.text, { required: true });
    if (textError) return c.json({ error: textError }, 400);

    const comment = await service.addComment(resolved.path, {
      anchor,
      text: body.text as string,
    });
    return c.json({ comment }, 201);
  });

  // PATCH /:projectId/review/comments/:commentId { text?, anchor? }
  routes.patch("/:projectId/review/comments/:commentId", async (c) => {
    const resolved = await resolveProjectPath(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const patch: {
      text?: string;
      anchor?: ReturnType<typeof parseReviewCommentAnchor>;
    } = {};
    if (body.text !== undefined) {
      const textError = validateText(body.text, { required: false });
      if (textError) return c.json({ error: textError }, 400);
      patch.text = body.text as string;
    }
    if (body.anchor !== undefined) {
      const anchor = parseReviewCommentAnchor(body.anchor);
      if (!anchor) return c.json({ error: "Invalid comment anchor" }, 400);
      patch.anchor = anchor;
    }

    const comment = await service.updateComment(
      resolved.path,
      c.req.param("commentId"),
      { text: patch.text, anchor: patch.anchor ?? undefined },
    );
    if (!comment) {
      return c.json({ error: "Pending comment not found" }, 404);
    }
    return c.json({ comment });
  });

  // DELETE /:projectId/review/comments/:commentId — discard a pending draft.
  routes.delete("/:projectId/review/comments/:commentId", async (c) => {
    const resolved = await resolveProjectPath(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const deleted = await service.deleteComment(
      resolved.path,
      c.req.param("commentId"),
    );
    if (!deleted) {
      return c.json({ error: "Pending comment not found" }, 404);
    }
    return c.json({ ok: true });
  });

  // POST /:projectId/review/preview — relocate every pending anchor and return
  // per-comment relocated|gone, gone-first and pre-selected discard. A dry run
  // of submit; mutates nothing.
  routes.post("/:projectId/review/preview", async (c) => {
    const resolved = await resolveProjectPath(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    const pending = await service.listPending(resolved.path);
    const relocations = await relocateAnchors(
      resolved.path,
      pending.map((comment) => comment.anchor),
    );
    const items = pending.map((comment, index) => {
      const relocation = relocations[index] as AnchorRelocation;
      return {
        comment,
        relocation,
        // Stale comments default to discard — usually too late to act on.
        defaultDiscard: relocation.status === "gone",
      };
    });
    // Gone comments first, so the discard-default block reads at the top.
    items.sort((a, b) => Number(b.defaultDiscard) - Number(a.defaultDiscard));
    return c.json({ items, pendingCount: pending.length });
  });

  // POST /:projectId/review/submit { include: string[], target: "new"|sessionId }
  // Re-relocate the included comments, compose the turn, launch/continue the
  // session, then archive the consumed batch against that session.
  routes.post("/:projectId/review/submit", async (c) => {
    const resolved = await resolveProjectPath(c.req.param("projectId"));
    if ("error" in resolved) {
      return c.json({ error: resolved.error }, resolved.status);
    }
    if (!deps.launcher) {
      return c.json({ error: "Review submit is not available" }, 501);
    }

    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);

    const include = parseStringArray(body.include);
    if (!include || include.length === 0) {
      return c.json({ error: "include must be a non-empty string array" }, 400);
    }
    const target = body.target;
    if (target !== "new" && typeof target !== "string") {
      return c.json({ error: "target must be 'new' or a session id" }, 400);
    }

    const pending = await service.listPending(resolved.path);
    const includeSet = new Set(include);
    const included = pending.filter((comment) => includeSet.has(comment.id));
    if (included.length === 0) {
      return c.json({ error: "No matching pending comments to submit" }, 400);
    }

    const relocations = await relocateAnchors(
      resolved.path,
      included.map((comment) => comment.anchor),
    );
    const relocationMap = new Map<string, AnchorRelocation>();
    included.forEach((comment, index) => {
      relocationMap.set(comment.id, relocations[index] as AnchorRelocation);
    });

    const turn = composeReviewTurn({
      comments: included,
      relocations: relocationMap,
      reviewFileRelPath: REVIEW_COMMENTS_REL_PATH,
      followUp: target !== "new",
    });

    let sessionId: string;
    if (target === "new") {
      const result = await deps.launcher.startReviewSession(
        resolved.path,
        turn,
      );
      if (result.status === "queue-full") {
        return c.json(
          { error: "Queue is full", maxQueueSize: result.maxQueueSize },
          503,
        );
      }
      if (result.status === "queued") {
        // Enqueued but no session id yet; leave the comments pending to retry.
        return c.json({ status: "queued" }, 202);
      }
      sessionId = result.sessionId;
    } else {
      const delivered = await deps.launcher.deliverFollowUp(target, turn);
      if (!delivered) {
        return c.json({ error: "Target session is not live" }, 409);
      }
      sessionId = target;
    }

    const batch = await service.archiveComments(resolved.path, {
      commentIds: included.map((comment) => comment.id),
      targetSessionId: sessionId,
    });
    return c.json({ sessionId, batchId: batch.id, consumed: batch.commentIds });
  });

  return routes;
}

function parseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return null;
    out.push(item);
  }
  return out;
}

async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json();
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Validate comment text; empty (after trim) is rejected only when required. */
function validateText(
  value: unknown,
  opts: { required: boolean },
): string | null {
  if (typeof value !== "string") return "Comment text must be a string";
  if (opts.required && value.trim().length === 0) {
    return "Comment text must not be empty";
  }
  if (value.length > MAX_REVIEW_COMMENT_TEXT_LENGTH) {
    return "Comment text is too long";
  }
  return null;
}
