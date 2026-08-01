import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewCommentAnchor } from "@yep-anywhere/shared";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { ReviewCommentService } from "../../src/review/ReviewCommentService.js";
import { createReviewInboxRoutes } from "../../src/routes/review-inbox.js";
import { createReviewSubmissionsRoutes } from "../../src/routes/review-submissions.js";
import type { Project } from "../../src/supervisor/types.js";

function anchor(): ReviewCommentAnchor {
  return {
    path: "src/a.ts",
    revision: { kind: "uncommitted", savedAt: "2026-08-01T00:00:00Z" },
    side: "new",
    oldLine: null,
    newLine: 3,
    snippet: "line",
  };
}

function projectFor(projectPath: string): Project {
  return {
    id: toUrlProjectId(projectPath),
    path: projectPath,
    name: "fixture",
    sessionCount: 0,
    sessionDir: join(projectPath, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
}

describe("review submission routes", () => {
  let dir: string;
  let project: Project;
  let scanner: ProjectScanner;
  let service: ReviewCommentService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "yep-review-submission-route-"));
    project = projectFor(dir);
    scanner = {
      async getProject(id: string) {
        return id === project.id ? project : null;
      },
      async listProjects() {
        return [project];
      },
    } as unknown as ProjectScanner;
    service = new ReviewCommentService();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("pages submission summaries and returns canonical site detail", async () => {
    const comment = await service.addComment(dir, {
      anchor: anchor(),
      text: "review this",
    });
    const batch = await service.archiveComments(dir, {
      commentIds: [comment.id],
      targetSessionId: "session-1",
    });
    const routes = createReviewSubmissionsRoutes({
      scanner,
      service,
      isEnabled: () => true,
    });

    const list = await routes.request(
      `/${project.id}/review/submissions?limit=1`,
    );
    expect(list.status).toBe(200);
    expect(await list.json()).toMatchObject({
      submissions: [{ id: batch.id, targetSessionId: "session-1" }],
      nextCursor: null,
    });

    const detail = await routes.request(
      `/${project.id}/review/submissions/${batch.id}`,
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.sites[0].entries[0]).toMatchObject({
      id: comment.id,
      capture: { status: "legacy-missing" },
    });
  });

  it("creates fresh follow-ups, resolves sites, and acknowledges explicitly", async () => {
    const comment = await service.addComment(dir, {
      anchor: anchor(),
      text: "first",
    });
    const batch = await service.archiveComments(dir, {
      commentIds: [comment.id],
      targetSessionId: "session-1",
    });
    const siteId = (await service.getStoreFile(dir)).sites[0]!.id;
    const routes = createReviewSubmissionsRoutes({
      scanner,
      service,
      isEnabled: () => true,
    });

    const resolved = await routes.request(
      `/${project.id}/review/sites/${siteId}/resolve`,
      { method: "POST" },
    );
    expect(resolved.status).toBe(200);

    const followUp = await routes.request(
      `/${project.id}/review/sites/${siteId}/follow-ups`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ anchor: anchor(), text: "please revisit" }),
      },
    );
    expect(followUp.status).toBe(201);
    const store = await service.getStoreFile(dir);
    expect(store.sites[0]?.entries).toHaveLength(2);
    expect(store.sites[0]?.resolvedAt).toBeUndefined();
    expect(store.drafts).toHaveLength(1);

    const acknowledged = await routes.request(
      `/${project.id}/review/submissions/${batch.id}/acknowledge`,
      { method: "POST" },
    );
    expect(acknowledged.status).toBe(200);
  });

  it("rejects the new workflow while its server setting is off", async () => {
    const routes = createReviewSubmissionsRoutes({
      scanner,
      service,
      isEnabled: () => false,
    });
    const response = await routes.request(
      `/${project.id}/review/submissions`,
    );
    expect(response.status).toBe(409);
  });

  it("lists unread submissions globally without acknowledging them", async () => {
    await mkdir(join(dir, ".yep"), { recursive: true });
    await writeFile(
      join(dir, ".yep", "review-comments.json"),
      JSON.stringify({
        version: 2,
        sites: [],
        drafts: [],
        submissions: [
          {
            id: "unread-1",
            name: "Check source review",
            submittedAt: "2026-08-01T10:00:00Z",
            requestedTarget: "session-1",
            targetSessionId: "session-1",
            entryRefs: [],
            status: "accepted",
            responseRevision: 2,
            acknowledgedRevision: 1,
          },
        ],
      }),
    );
    const inboxService = new ReviewCommentService();
    const routes = createReviewInboxRoutes({
      scanner,
      service: inboxService,
      isEnabled: () => true,
    });

    const response = await routes.request("/review/inbox");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [
        {
          projectId: project.id,
          submissionId: "unread-1",
          responseRevision: 2,
        },
      ],
    });
    expect(
      (await inboxService.getStoreFile(dir)).submissions[0]
        ?.acknowledgedRevision,
    ).toBe(1);
  });
});
