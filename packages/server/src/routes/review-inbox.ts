/** Global unread source-review outcomes for the Inbox surface. */

import { Hono } from "hono";
import type { ProjectScanner } from "../projects/scanner.js";
import type { ReviewCommentService } from "../review/ReviewCommentService.js";

export interface ReviewInboxDeps {
  scanner: Pick<ProjectScanner, "listProjects">;
  service: ReviewCommentService;
  isEnabled: () => boolean;
}

export function createReviewInboxRoutes(deps: ReviewInboxDeps): Hono {
  const routes = new Hono();

  routes.get("/review/inbox", async (c) => {
    if (!deps.isEnabled()) {
      return c.json({ error: "Source-review submissions are not enabled" }, 409);
    }
    const projects = await deps.scanner.listProjects();
    const items = (
      await Promise.all(
        projects.map(async (project) => {
          const store = await deps.service.getStoreFile(project.path);
          return store.submissions.flatMap((submission) =>
            submission.responseRevision > submission.acknowledgedRevision
              ? [
                  {
                    projectId: project.id,
                    projectName: project.name,
                    submissionId: submission.id,
                    name: submission.name,
                    targetSessionId: submission.targetSessionId,
                    responseRevision: submission.responseRevision,
                  },
                ]
              : [],
          );
        }),
      )
    )
      .flat()
      .sort((left, right) => right.responseRevision - left.responseRevision);
    return c.json({ items });
  });

  return routes;
}
