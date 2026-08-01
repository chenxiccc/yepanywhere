/** Capability-gated canonical source-review submission and site routes. */

import {
  MAX_REVIEW_COMMENT_TEXT_LENGTH,
  type ReviewCommentAnchor,
  parseReviewCommentAnchor,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { structuredErrorHandler } from "../middleware/error-handler.js";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ReviewCommentService } from "../review/ReviewCommentService.js";
import { repositoryRelativePath } from "../review/repositoryPath.js";
import { resolveProjectPath } from "./projectParam.js";

export interface ReviewSubmissionsDeps {
  scanner: ProjectScanner;
  service: ReviewCommentService;
  isEnabled: () => boolean;
}

export function createReviewSubmissionsRoutes(
  deps: ReviewSubmissionsDeps,
): Hono {
  const routes = new Hono();
  routes.onError(structuredErrorHandler);

  routes.get("/:projectId/review/submissions", async (c) => {
    const disabled = requireEnabled(c, deps);
    if (disabled) return disabled;
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    const page = parsePage(c.req.query("cursor"), c.req.query("limit"));
    if (!page) return c.json({ error: "Invalid submission page" }, 400);
    const store = await deps.service.getStoreFile(projectPath);
    const ordered = [...store.submissions].sort((left, right) =>
      right.submittedAt.localeCompare(left.submittedAt),
    );
    const submissions = ordered.slice(page.offset, page.offset + page.limit);
    const nextOffset = page.offset + submissions.length;
    return c.json({
      submissions,
      nextCursor: nextOffset < ordered.length ? String(nextOffset) : null,
    });
  });

  routes.get(
    "/:projectId/review/submissions/:submissionId",
    async (c) => {
      const disabled = requireEnabled(c, deps);
      if (disabled) return disabled;
      const projectPath = await resolveProjectPath(c, deps.scanner);
      if (typeof projectPath !== "string") return projectPath;
      const detail = await submissionDetail(
        deps.service,
        projectPath,
        c.req.param("submissionId"),
      );
      return detail
        ? c.json(detail)
        : c.json({ error: "Review submission not found" }, 404);
    },
  );

  routes.post(
    "/:projectId/review/submissions/:submissionId/acknowledge",
    async (c) => {
      const disabled = requireEnabled(c, deps);
      if (disabled) return disabled;
      const projectPath = await resolveProjectPath(c, deps.scanner);
      if (typeof projectPath !== "string") return projectPath;
      const submission = await deps.service.acknowledgeSubmission(
        projectPath,
        c.req.param("submissionId"),
      );
      return submission
        ? c.json({ submission })
        : c.json({ error: "Review submission not found" }, 404);
    },
  );

  routes.post(
    "/:projectId/review/submissions/:submissionId/refresh-response",
    async (c) => {
      const disabled = requireEnabled(c, deps);
      if (disabled) return disabled;
      const projectPath = await resolveProjectPath(c, deps.scanner);
      if (typeof projectPath !== "string") return projectPath;
      const detail = await submissionDetail(
        deps.service,
        projectPath,
        c.req.param("submissionId"),
      );
      return detail
        ? c.json({ ...detail, refreshed: false })
        : c.json({ error: "Review submission not found" }, 404);
    },
  );

  routes.post("/:projectId/review/sites/:siteId/follow-ups", async (c) => {
    const disabled = requireEnabled(c, deps);
    if (disabled) return disabled;
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    const body = await readJsonBody(c);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const anchor = parseReviewCommentAnchor(body.anchor);
    if (!anchor || !validAnchorPaths(anchor)) {
      return c.json({ error: "Invalid comment anchor" }, 400);
    }
    if (
      typeof body.text !== "string" ||
      body.text.trim().length === 0 ||
      body.text.length > MAX_REVIEW_COMMENT_TEXT_LENGTH
    ) {
      return c.json({ error: "Invalid follow-up text" }, 400);
    }
    const entry = await deps.service.addFollowUp(
      projectPath,
      c.req.param("siteId"),
      { anchor, text: body.text },
    );
    return entry
      ? c.json({ entry }, 201)
      : c.json({ error: "Review site not found" }, 404);
  });

  routes.post("/:projectId/review/sites/:siteId/resolve", async (c) => {
    const disabled = requireEnabled(c, deps);
    if (disabled) return disabled;
    const projectPath = await resolveProjectPath(c, deps.scanner);
    if (typeof projectPath !== "string") return projectPath;
    const resolved = await deps.service.resolveSite(
      projectPath,
      c.req.param("siteId"),
    );
    return resolved
      ? c.json({ resolved: true })
      : c.json({ error: "Review site not found" }, 404);
  });

  return routes;
}

async function submissionDetail(
  service: ReviewCommentService,
  projectPath: string,
  submissionId: string,
) {
  const store = await service.getStoreFile(projectPath);
  const submission = store.submissions.find((item) => item.id === submissionId);
  if (!submission) return null;
  const siteIds = new Set(submission.entryRefs.map((ref) => ref.siteId));
  return {
    submission,
    sites: store.sites.filter((site) => siteIds.has(site.id)),
  };
}

function parsePage(cursor: string | undefined, limit: string | undefined) {
  const offset = cursor === undefined ? 0 : Number(cursor);
  const pageSize = limit === undefined ? 50 : Number(limit);
  if (
    !Number.isInteger(offset) ||
    offset < 0 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    return null;
  }
  return { offset, limit: pageSize };
}

function requireEnabled(
  c: { json: (body: { error: string }, status: 409) => Response },
  deps: ReviewSubmissionsDeps,
): Response | null {
  return deps.isEnabled()
    ? null
    : c.json({ error: "Source-review submissions are not enabled" }, 409);
}

function validAnchorPaths(anchor: ReviewCommentAnchor): boolean {
  try {
    repositoryRelativePath(anchor.path);
    if (anchor.projection) repositoryRelativePath(anchor.projection.path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonBody(c: {
  req: { json: () => Promise<unknown> };
}): Promise<Record<string, unknown> | null> {
  try {
    const parsed = await c.req.json();
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
