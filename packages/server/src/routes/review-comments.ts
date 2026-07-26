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

export interface ReviewCommentsDeps {
  scanner: ProjectScanner;
  /** Injectable for tests (stub clock/id); a fresh service by default. */
  service?: ReviewCommentService;
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

  return routes;
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
