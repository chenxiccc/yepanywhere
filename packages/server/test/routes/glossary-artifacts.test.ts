import {
  GLOSSARY_SOURCE_PATH_MAX_LENGTH,
  type GlossaryArtifactResponse,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { GlossaryIndexService } from "../../src/projects/glossaryIndexService.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createGlossaryArtifactRoutes } from "../../src/routes/glossary-artifacts.js";
import type { Project } from "../../src/supervisor/types.js";

const PROJECT_PATH = "/projects/paper";
const PROJECT_ID = toUrlProjectId(PROJECT_PATH);

function readyResponse(): GlossaryArtifactResponse {
  return {
    artifact: {
      nodes: [
        {
          failure: 0,
          outputs: [],
          transitions: {},
        },
      ],
      sourceVersion: "content-v1",
      terminals: [],
      version: 1,
    },
    dependencies: [
      {
        contentHash: "abc123",
        path: "papers/GLOSSARY.md",
        size: 42,
      },
    ],
    diagnostics: [],
    governingPath: "papers/GLOSSARY.md",
    sourceVersion: "content-v1",
    status: "ready",
  };
}

function createRoutes(result: GlossaryArtifactResponse = readyResponse()) {
  const project: Project = {
    id: PROJECT_ID,
    path: PROJECT_PATH,
    name: "paper",
    sessionCount: 0,
    sessionDir: "/sessions/paper",
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
  const scanner = {
    getProject: vi.fn(async (id: string) =>
      id === PROJECT_ID ? project : null,
    ),
  } as unknown as ProjectScanner;
  const service = {
    resolve: vi.fn(async () => result),
  } as unknown as GlossaryIndexService;
  return {
    routes: createGlossaryArtifactRoutes({ scanner, service }),
    scanner,
    service,
  };
}

describe("glossary artifact route", () => {
  it("serializes one compiled automaton for one source file", async () => {
    const { routes, service } = createRoutes();

    const response = await routes.request(
      `/${PROJECT_ID}/glossary-artifact?sourcePath=papers%2Fdraft.md`,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(readyResponse());
    expect(service.resolve).toHaveBeenCalledWith(
      PROJECT_PATH,
      "papers/draft.md",
    );
  });

  it("uses the project-root glossary when sourcePath is omitted", async () => {
    const { routes, service } = createRoutes();

    const response = await routes.request(`/${PROJECT_ID}/glossary-artifact`);

    expect(response.status).toBe(200);
    expect(service.resolve).toHaveBeenCalledWith(PROJECT_PATH, undefined);
  });

  it("rejects empty, oversized, and escaping source paths", async () => {
    const { routes, service } = createRoutes({
      reason: "invalid-source-path",
      status: "none",
    });

    const empty = await routes.request(
      `/${PROJECT_ID}/glossary-artifact?sourcePath=`,
    );
    const oversized = await routes.request(
      `/${PROJECT_ID}/glossary-artifact?sourcePath=${"x".repeat(
        GLOSSARY_SOURCE_PATH_MAX_LENGTH + 1,
      )}`,
    );
    const escaping = await routes.request(
      `/${PROJECT_ID}/glossary-artifact?sourcePath=..%2Foutside.md`,
    );

    expect(empty.status).toBe(400);
    expect(oversized.status).toBe(400);
    expect(escaping.status).toBe(400);
    expect(service.resolve).toHaveBeenCalledTimes(1);
  });

  it("returns no artifact when the project has no governing glossary", async () => {
    const result: GlossaryArtifactResponse = {
      reason: "no-governing-glossary",
      status: "none",
    };
    const { routes } = createRoutes(result);

    const response = await routes.request(`/${PROJECT_ID}/glossary-artifact`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(result);
  });

  it("rejects unknown projects before glossary resolution", async () => {
    const { routes, service } = createRoutes();
    const unknownId = toUrlProjectId("/projects/unknown");

    const response = await routes.request(`/${unknownId}/glossary-artifact`);

    expect(response.status).toBe(404);
    expect(service.resolve).not.toHaveBeenCalled();
  });
});
