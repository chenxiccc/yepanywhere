import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { ReviewCommentService } from "../../src/review/ReviewCommentService.js";
import { createReviewInboxRoutes } from "../../src/routes/review-inbox.js";

type ScannerProjects = Awaited<ReturnType<ProjectScanner["listProjects"]>>;
type StoreFile = Awaited<ReturnType<ReviewCommentService["getStoreFile"]>>;

interface StoreShape {
  submissions: Array<{
    id: string;
    name: string;
    targetSessionId: string;
    responseRevision: number;
    acknowledgedRevision: number;
    entryRefs: Array<{ siteId: string; entryId: string }>;
  }>;
  sites: Array<{
    id: string;
    path: string;
    outcomes: Array<{ entryId: string; disposition: string }>;
  }>;
}

function unreadStore(submissionId: string): StoreShape {
  return {
    submissions: [
      {
        id: submissionId,
        name: `submission ${submissionId}`,
        targetSessionId: `session-${submissionId}`,
        responseRevision: 2,
        acknowledgedRevision: 1,
        entryRefs: [{ siteId: "site-1", entryId: "entry-1" }],
      },
    ],
    sites: [
      {
        id: "site-1",
        path: "src/index.ts",
        outcomes: [{ entryId: "entry-1", disposition: "accepted" }],
      },
    ],
  };
}

function emptyStore(): StoreShape {
  return { submissions: [], sites: [] };
}

function harness(options: { projects?: number } = {}) {
  const projectCount = options.projects ?? 200;
  const projects = Array.from({ length: projectCount }, (_, index) => ({
    id: `p${index}`,
    name: `Project ${index}`,
    path: `/projects/p${index}`,
  }));
  const counts = { listProjects: 0, storeLoads: 0 };
  let revision = 0;
  const clock = { value: 1_000_000 };

  const app = new Hono();
  app.route(
    "/api",
    createReviewInboxRoutes({
      scanner: {
        listProjects: async () => {
          counts.listProjects += 1;
          return projects as unknown as ScannerProjects;
        },
      },
      service: {
        getStoreFile: async (projectPath: string) => {
          counts.storeLoads += 1;
          const store =
            projectPath === "/projects/p7" ? unreadStore("s7") : emptyStore();
          return store as unknown as StoreFile;
        },
        getStateRevision: () => revision,
      },
      isEnabled: () => true,
      projectSetTtlMs: 5_000,
      now: () => clock.value,
    }),
  );

  return {
    app,
    counts,
    clock,
    bumpRevision: () => {
      revision += 1;
    },
    get: async (query = "") => {
      const response = await app.request(`/api/review/inbox${query}`);
      return (await response.json()) as { items: Array<{ projectId: string }> };
    },
  };
}

describe("review inbox retention", () => {
  it("builds the projection once for repeated unchanged requests", async () => {
    const test = harness({ projects: 200 });

    const first = await test.get();
    expect(first.items).toHaveLength(1);
    expect(test.counts.listProjects).toBe(1);
    expect(test.counts.storeLoads).toBe(200);

    await test.get();
    await test.get();

    expect(test.counts.listProjects).toBe(1);
    expect(test.counts.storeLoads).toBe(200);
  });

  it("serves concurrent requests from one build", async () => {
    const test = harness({ projects: 50 });

    const responses = await Promise.all(
      Array.from({ length: 20 }, () => test.get()),
    );

    expect(responses.every((body) => body.items.length === 1)).toBe(true);
    expect(test.counts.listProjects).toBe(1);
    expect(test.counts.storeLoads).toBe(50);
  });

  it("rebuilds once after an accepted review mutation", async () => {
    const test = harness({ projects: 20 });
    await test.get();

    test.bumpRevision();
    await test.get();
    await test.get();

    expect(test.counts.listProjects).toBe(2);
    expect(test.counts.storeLoads).toBe(40);
  });

  it("rebuilds after the project-set backstop window", async () => {
    const test = harness({ projects: 20 });
    await test.get();

    test.clock.value += 5_001;
    await test.get();

    expect(test.counts.listProjects).toBe(2);
  });

  it("filters by project without rebuilding the projection", async () => {
    const test = harness({ projects: 20 });
    await test.get();
    const loadsAfterFirst = test.counts.storeLoads;

    const matched = await test.get("?projectId=p7");
    const missed = await test.get("?projectId=p3");

    expect(matched.items.map((item) => item.projectId)).toEqual(["p7"]);
    expect(missed.items).toEqual([]);
    expect(test.counts.storeLoads).toBe(loadsAfterFirst);
    expect(test.counts.listProjects).toBe(1);
  });

  it("does no project or store work while the feature is disabled", async () => {
    const counts = { listProjects: 0, storeLoads: 0 };
    const app = new Hono();
    app.route(
      "/api",
      createReviewInboxRoutes({
        scanner: {
          listProjects: async () => {
            counts.listProjects += 1;
            return [];
          },
        },
        service: {
          getStoreFile: async () => {
            counts.storeLoads += 1;
            return emptyStore() as unknown as StoreFile;
          },
          getStateRevision: () => 0,
        },
        isEnabled: () => false,
      }),
    );

    const response = await app.request("/api/review/inbox");

    expect(response.status).toBe(409);
    expect(counts).toEqual({ listProjects: 0, storeLoads: 0 });
  });
});
