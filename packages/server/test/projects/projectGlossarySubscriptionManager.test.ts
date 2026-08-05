import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type GlossaryPathChangedEvent,
  type GlossaryPathsSnapshotEvent,
  type GlossarySubscriptionEvent,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlossaryPathObservation } from "../../src/projects/glossaryIndexService.js";
import {
  ProjectGlossarySubscriptionManager,
  type ProjectGlossarySubscriptionManagerOptions,
} from "../../src/projects/projectGlossarySubscriptionManager.js";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import type { Project } from "../../src/supervisor/types.js";

const temporaryDirectories: string[] = [];

/**
 * Stand in for the resolver's observation set: tests observe the candidates a
 * source context would have named, and each new one notifies the manager the
 * way `GlossaryIndexService.observePaths` does.
 */
async function createHarness(options: { pollMs?: number } = {}) {
  const projectPath = await realpath(
    await mkdtemp(join(tmpdir(), "ya-glossary-watch-")),
  );
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
  const observations = new Map<string, GlossaryPathObservation["identity"]>();
  const observationListeners = new Set<(projectRoot: string) => void>();
  const glossaryIndexService: ProjectGlossarySubscriptionManagerOptions["glossaryIndexService"] =
    {
      getObservedGlossaryPaths: vi.fn(() =>
        [...observations.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([path, identity]) => ({ identity, path })),
      ),
      invalidateProject,
      onObservationsChanged: vi.fn((listener) => {
        observationListeners.add(listener);
        return () => {
          observationListeners.delete(listener);
        };
      }),
    };
  const manager = new ProjectGlossarySubscriptionManager({
    scanner,
    glossaryIndexService,
    debounceMs: 25,
    pollMs: options.pollMs ?? 600_000,
  });
  return {
    glossaryIndexService,
    invalidateProject,
    manager,
    observePath: (path: string) => {
      if (observations.has(path)) return;
      observations.set(path, null);
      for (const listener of observationListeners) listener(projectPath);
    },
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

function changeEvents(
  events: readonly GlossarySubscriptionEvent[],
): GlossaryPathChangedEvent[] {
  return events.filter(
    (event): event is GlossaryPathChangedEvent =>
      event.type === "glossary-path-changed",
  );
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("ProjectGlossarySubscriptionManager", () => {
  it("sends observed glossary paths first and reports later changes", async () => {
    const { manager, projectId, projectPath, invalidateProject, observePath } =
      await createHarness();
    await mkdir(join(projectPath, "papers"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "paper");
    observePath("GLOSSARY.md");
    observePath("papers/GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];

    const unsubscribe = await manager.subscribe(projectId, (event) => {
      events.push(event);
    });

    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["GLOSSARY.md", "papers/GLOSSARY.md"],
    } satisfies Partial<GlossaryPathsSnapshotEvent>);
    expect(manager.diagnostics().watchedDirectories).toBe(2);

    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "revised");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected glossary modification event",
    );

    const change = changeEvents(events)[0];
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
      watchedDirectories: 0,
    });
    manager.dispose();
  });

  it("watches only directories holding an observed candidate", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness();
    await mkdir(join(projectPath, "unqueried"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "unqueried", "GLOSSARY.md"), "unqueried");
    observePath("GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];

    const unsubscribe = await manager.subscribe(projectId, (event) => {
      events.push(event);
    });

    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["GLOSSARY.md"],
    } satisfies Partial<GlossaryPathsSnapshotEvent>);
    expect(manager.diagnostics().watchedDirectories).toBe(1);

    await writeFile(join(projectPath, "unqueried", "GLOSSARY.md"), "edited");
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(changeEvents(events)).toEqual([]);

    unsubscribe();
    manager.dispose();
  });

  it("detects a nearer glossary created in an observed directory", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness();
    await mkdir(join(projectPath, "papers"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    // The nearest candidate is missing, so it stays observed for its creation.
    observePath("papers/GLOSSARY.md");
    observePath("GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];
    const unsubscribe = await manager.subscribe(projectId, (event) => {
      events.push(event);
    });

    expect(events[0]).toMatchObject({
      type: "glossary-paths-snapshot",
      paths: ["GLOSSARY.md"],
    } satisfies Partial<GlossaryPathsSnapshotEvent>);

    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "nearer");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected nearer glossary creation event",
    );

    expect(changeEvents(events)[0]).toMatchObject({
      changeType: "create",
      path: "papers/GLOSSARY.md",
    });
    unsubscribe();
    manager.dispose();
  });

  it("watches a directory resolution observes after subscription", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness();
    await mkdir(join(projectPath, "docs"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];
    const unsubscribe = await manager.subscribe(projectId, (event) => {
      events.push(event);
    });
    expect(manager.diagnostics().watchedDirectories).toBe(1);

    // The handoff, not the poll, is what makes the new directory watched.
    observePath("docs/GLOSSARY.md");
    await waitFor(
      () => manager.diagnostics().watchedDirectories === 2,
      "Expected the newly observed directory to be watched",
    );

    await writeFile(join(projectPath, "docs", "GLOSSARY.md"), "docs");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected creation event from the newly watched directory",
    );
    expect(changeEvents(events)[0]).toMatchObject({
      changeType: "create",
      path: "docs/GLOSSARY.md",
    });

    unsubscribe();
    manager.dispose();
  });

  it("treats an already existing observed candidate as discovery, not creation", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness();
    await mkdir(join(projectPath, "papers"));
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "paper");
    observePath("GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];
    const unsubscribe = await manager.subscribe(projectId, (event) => {
      events.push(event);
    });

    observePath("papers/GLOSSARY.md");
    await waitFor(
      () => manager.diagnostics().watchedDirectories === 2,
      "Expected the newly observed directory to be watched",
    );
    // A create event would invalidate every artifact the tab holds, and
    // nothing on disk changed — the path was merely learned about.
    expect(changeEvents(events)).toEqual([]);

    await writeFile(join(projectPath, "papers", "GLOSSARY.md"), "revised");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected a later edit to that candidate to report a modification",
    );
    expect(changeEvents(events)[0]).toMatchObject({
      changeType: "modify",
      path: "papers/GLOSSARY.md",
    });

    unsubscribe();
    manager.dispose();
  });

  it("polls as the backstop for a candidate whose directory is unwatchable", async () => {
    const { manager, observePath, projectId, projectPath } = await createHarness(
      { pollMs: 1_000 },
    );
    await writeFile(join(projectPath, "GLOSSARY.md"), "root");
    observePath("GLOSSARY.md");
    // No `absent` directory exists, so this candidate gets no watch at all.
    observePath("absent/GLOSSARY.md");
    const events: GlossarySubscriptionEvent[] = [];
    const unsubscribe = await manager.subscribe(projectId, (event) => {
      events.push(event);
    });
    expect(manager.diagnostics().watchedDirectories).toBe(1);

    await mkdir(join(projectPath, "absent"));
    await writeFile(join(projectPath, "absent", "GLOSSARY.md"), "late");
    await waitFor(
      () => changeEvents(events).length > 0,
      "Expected the poll to report the unwatched candidate's creation",
    );
    expect(changeEvents(events)[0]).toMatchObject({
      changeType: "create",
      path: "absent/GLOSSARY.md",
    });
    // The same refresh retries the attach, so later edits need no poll.
    expect(manager.diagnostics().watchedDirectories).toBe(2);

    unsubscribe();
    manager.dispose();
  });

  it("shares one project state across subscribers and detects offline edits", async () => {
    const { manager, observePath, projectId, projectPath } =
      await createHarness();
    await writeFile(join(projectPath, "GLOSSARY.md"), "one");
    observePath("GLOSSARY.md");
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
      watchedDirectories: 1,
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
