import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GlossaryPathChangedEvent,
  type GlossaryPathsSnapshotEvent,
  type GlossarySubscriptionEvent,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlossaryIndexService } from "../../src/projects/glossaryIndexService.js";
import { ProjectGlossarySubscriptionManager } from "../../src/projects/projectGlossarySubscriptionManager.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { Project } from "../../src/supervisor/types.js";

const temporaryDirectories: string[] = [];

async function createHarness() {
  const projectPath = await mkdtemp(join(tmpdir(), "ya-glossary-watch-"));
  temporaryDirectories.push(projectPath);
  const projectId = toUrlProjectId(projectPath);
  const project: Project = {
    id: projectId,
    path: projectPath,
    name: "glossary-watch",
    sessionCount: 0,
    sessionDir: join(projectPath, ".sessions"),
    activeOwnedCount: 0,
    activeExternalCount: 0,
    lastActivity: null,
    provider: "claude",
  };
  const scanner = {
    getProject: vi.fn(async (id: string) =>
      id === projectId ? project : null,
    ),
  } as unknown as ProjectScanner;
  const invalidateProject = vi.fn();
  const glossaryIndexService = {
    invalidateProject,
  } as unknown as GlossaryIndexService;
  const manager = new ProjectGlossarySubscriptionManager({
    scanner,
    glossaryIndexService,
    debounceMs: 25,
    pollMs: 1_000,
  });
  return {
    glossaryIndexService,
    invalidateProject,
    manager,
    projectId,
    projectPath,
  };
}

async function waitFor(
  predicate: () => boolean,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ProjectGlossarySubscriptionManager", () => {
  it("sends all glossary paths first and reports later changes", async () => {
    const { manager, projectId, projectPath, invalidateProject } =
      await createHarness();
    await mkdir(join(projectPath, "papers"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "paper");
    const events: GlossarySubscriptionEvent[] = [];

    const unsubscribe = await manager.subscribe(projectId, (event) => {
      events.push(event);
    });

    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["GLOSSARY.md", "papers/GLOSSARY.md"],
    } satisfies Partial<GlossaryPathsSnapshotEvent>);

    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "revised");
    await waitFor(
      () => events.some((event) => event.type === "glossary-path-changed"),
      "Expected glossary modification event",
    );

    const change = events.find(
      (event): event is GlossaryPathChangedEvent =>
        event.type === "glossary-path-changed",
    );
    expect(change).toMatchObject({
      changeType: "modify",
      path: "papers/GLOSSARY.md",
    });
    expect(change?.generation.sequence).toBe(1);
    expect(invalidateProject).toHaveBeenCalledWith(projectPath);

    unsubscribe();
    expect(manager.diagnostics()).toEqual({
      activeProjects: 0,
      retainedProjects: 1,
      subscribers: 0,
    });
    manager.dispose();
  });

  it("shares one project state across subscribers and detects offline edits", async () => {
    const { manager, projectId, projectPath } = await createHarness();
    await writeFile(join(projectPath, "GLOSSARY.md"), "one");
    const firstEvents: GlossarySubscriptionEvent[] = [];
    const secondEvents: GlossarySubscriptionEvent[] = [];

    const unsubscribeFirst = await manager.subscribe(projectId, (event) => {
      firstEvents.push(event);
    });
    const unsubscribeSecond = await manager.subscribe(projectId, (event) => {
      secondEvents.push(event);
    });
    expect(manager.diagnostics()).toEqual({
      activeProjects: 1,
      retainedProjects: 1,
      subscribers: 2,
    });
    expect(firstEvents[0]?.type).toBe("glossary-paths-snapshot");
    expect(secondEvents[0]?.type).toBe("glossary-paths-snapshot");

    unsubscribeFirst();
    unsubscribeSecond();
    await writeFile(join(projectPath, "GLOSSARY.md"), "two");

    const resumedEvents: GlossarySubscriptionEvent[] = [];
    const unsubscribeResumed = await manager.subscribe(projectId, (event) => {
      resumedEvents.push(event);
    });
    expect(resumedEvents).toHaveLength(1);
    expect(resumedEvents[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      generation: { sequence: 1 },
      paths: ["GLOSSARY.md"],
    });

    unsubscribeResumed();
    manager.dispose();
  });
});
