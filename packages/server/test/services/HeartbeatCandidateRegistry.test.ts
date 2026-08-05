import { describe, expect, it } from "vitest";
import {
  HeartbeatCandidateRegistry,
  type HeartbeatCandidateMetadata,
  type HeartbeatCandidateProject,
  type HeartbeatCandidateResolution,
} from "../../src/services/HeartbeatCandidateRegistry.js";

interface Harness {
  registry: HeartbeatCandidateRegistry;
  counts: {
    listProjects: number;
    resolve: number;
    tailReads: number;
  };
  owned: Set<string>;
  /** Session id -> project id it can be resolved in, or null when missing. */
  placement: Map<string, string | null>;
  updatedAt: Map<string, string>;
  pending: Map<string, boolean>;
  now: { value: number };
}

function harness(
  options: {
    projects?: number;
    eligible?: Array<[string, HeartbeatCandidateMetadata]>;
  } = {},
): Harness {
  const projectCount = options.projects ?? 50;
  const projects: HeartbeatCandidateProject[] = Array.from(
    { length: projectCount },
    (_, index) => ({ id: `p${index}`, path: `/projects/p${index}` }),
  );
  const eligible = options.eligible ?? [["s1", {}]];
  const counts = { listProjects: 0, resolve: 0, tailReads: 0 };
  const owned = new Set<string>();
  const placement = new Map<string, string | null>([["s1", "p40"]]);
  const updatedAt = new Map<string, string>([
    ["s1", "2026-08-01T00:00:00.000Z"],
  ]);
  const pending = new Map<string, boolean>([["s1", true]]);
  const now = { value: 1_000_000 };

  const registry = new HeartbeatCandidateRegistry(
    {
      listEligible: () => eligible,
      isOwned: (sessionId) => owned.has(sessionId),
      listProjects: async () => {
        counts.listProjects += 1;
        return projects;
      },
      getProject: async (projectId) =>
        projects.find((project) => project.id === projectId),
      resolve: async (
        project,
        sessionId,
      ): Promise<HeartbeatCandidateResolution | null> => {
        counts.resolve += 1;
        if (placement.get(sessionId) !== project.id) return null;
        const stamp = updatedAt.get(sessionId) ?? "2026-08-01T00:00:00.000Z";
        return {
          projectId: project.id,
          projectPath: project.path,
          provider: "codex",
          updatedAt: stamp,
          sourceVersion: `codex\0${stamp}`,
          readPendingToolCall: async () => {
            counts.tailReads += 1;
            return pending.get(sessionId) ?? false;
          },
        };
      },
    },
    { now: () => now.value, unresolvedBackoffMs: 60_000 },
  );

  return { registry, counts, owned, placement, updatedAt, pending, now };
}

describe("HeartbeatCandidateRegistry", () => {
  it("lists no projects when every eligible session is owned", async () => {
    const test = harness();
    test.owned.add("s1");

    expect(await test.registry.getCandidates()).toEqual([]);
    expect(test.counts.listProjects).toBe(0);
    expect(test.counts.resolve).toBe(0);
    expect(test.registry.getMetrics().ownedSkipped).toBe(1);
  });

  it("lists no projects when nothing is eligible", async () => {
    const test = harness({ eligible: [] });

    expect(await test.registry.getCandidates()).toEqual([]);
    expect(test.counts.listProjects).toBe(0);
  });

  it("searches once, then resolves the retained location exactly", async () => {
    const test = harness({ projects: 50 });

    const first = await test.registry.getCandidates();
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      sessionId: "s1",
      projectId: "p40",
      provider: "codex",
      hasPendingToolCall: true,
    });
    const searchResolves = test.counts.resolve;
    expect(searchResolves).toBe(41);
    expect(test.counts.listProjects).toBe(1);

    await test.registry.getCandidates();
    await test.registry.getCandidates();

    // Two more generations cost one exact resolve each and no fleet listing.
    expect(test.counts.resolve).toBe(searchResolves + 2);
    expect(test.counts.listProjects).toBe(1);
    expect(test.registry.getMetrics().locationHits).toBe(2);
  });

  it("does not reparse a transcript whose source version is unchanged", async () => {
    const test = harness();

    await test.registry.getCandidates();
    await test.registry.getCandidates();
    await test.registry.getCandidates();

    expect(test.counts.tailReads).toBe(1);
    expect(test.registry.getMetrics().tailReuses).toBe(2);
  });

  it("reparses exactly once after the transcript advances", async () => {
    const test = harness();
    await test.registry.getCandidates();

    test.updatedAt.set("s1", "2026-08-02T00:00:00.000Z");
    await test.registry.getCandidates();
    await test.registry.getCandidates();

    expect(test.counts.tailReads).toBe(2);
  });

  it("keeps a settled non-pending tail from reparsing on the interval", async () => {
    const test = harness();
    test.pending.set("s1", false);

    expect(await test.registry.getCandidates()).toEqual([]);
    expect(await test.registry.getCandidates()).toEqual([]);
    expect(test.counts.tailReads).toBe(1);
  });

  it("defers an unlocatable candidate instead of researching every tick", async () => {
    const test = harness({ projects: 50 });
    test.placement.set("s1", null);

    expect(await test.registry.getCandidates()).toEqual([]);
    const afterFirst = test.counts.resolve;
    expect(afterFirst).toBe(50);

    expect(await test.registry.getCandidates()).toEqual([]);
    expect(test.counts.resolve).toBe(afterFirst);
    expect(test.registry.getMetrics().unresolvedDeferrals).toBe(1);

    test.now.value += 60_001;
    test.placement.set("s1", "p3");
    expect(await test.registry.getCandidates()).toHaveLength(1);
    expect(test.counts.resolve).toBe(afterFirst + 4);
  });

  it("backs off further each time a candidate stays unlocatable", async () => {
    const test = harness({ projects: 10 });
    test.placement.set("s1", null);

    await test.registry.getCandidates();
    test.now.value += 60_001;
    await test.registry.getCandidates();
    const afterSecondSearch = test.counts.resolve;

    // The second failure doubled the window, so the same delay is too soon.
    test.now.value += 60_001;
    await test.registry.getCandidates();
    expect(test.counts.resolve).toBe(afterSecondSearch);
    expect(test.registry.getMetrics().unresolvedSearches).toBe(2);
  });

  it("relocates a session whose transcript moved to another project", async () => {
    const test = harness({ projects: 50 });
    await test.registry.getCandidates();
    const afterFirst = test.counts.resolve;

    test.placement.set("s1", "p2");
    const rows = await test.registry.getCandidates();

    expect(rows[0]).toMatchObject({ projectId: "p2" });
    // One failed exact probe, then a search that stops at p2.
    expect(test.counts.resolve).toBe(afterFirst + 1 + 3);
    expect(test.counts.listProjects).toBe(2);
  });

  it("reports a settled tail as waiting so the scheduler looks again", async () => {
    const test = harness();
    test.pending.set("s1", false);

    expect(await test.registry.getCandidates()).toEqual([]);
    expect(test.registry.getWaitingSessionIds()).toEqual(["s1"]);

    // Once it is due, it is a row rather than a wait.
    test.pending.set("s1", true);
    test.updatedAt.set("s1", "2026-08-02T00:00:00.000Z");
    expect(await test.registry.getCandidates()).toHaveLength(1);
    expect(test.registry.getWaitingSessionIds()).toEqual([]);
  });

  it("reports an unlocatable candidate as waiting, not as absent", async () => {
    const test = harness({ projects: 10 });
    test.placement.set("s1", null);

    expect(await test.registry.getCandidates()).toEqual([]);
    expect(test.registry.getWaitingSessionIds()).toEqual(["s1"]);

    // Still waiting while its retry is deferred; the deadline owner must not
    // conclude the session went away.
    expect(await test.registry.getCandidates()).toEqual([]);
    expect(test.registry.getWaitingSessionIds()).toEqual(["s1"]);
  });

  it("reports no waiting sessions when every eligible session is owned", async () => {
    const test = harness();
    test.owned.add("s1");

    await test.registry.getCandidates();
    expect(test.registry.getWaitingSessionIds()).toEqual([]);
  });

  it("forgets retained state once a session stops being eligible", async () => {
    const eligible: Array<[string, HeartbeatCandidateMetadata]> = [["s1", {}]];
    const test = harness({ projects: 50, eligible });
    await test.registry.getCandidates();
    expect(test.registry.getMetrics().forgotten).toBe(0);

    // Archiving or an exemption removes the row from the eligible set.
    eligible.length = 0;
    await test.registry.getCandidates();
    expect(test.registry.getMetrics().forgotten).toBe(1);
    expect(test.registry.getMetrics().retainedBytes).toBe(0);

    // Re-enabling it re-locates from scratch rather than trusting stale state.
    eligible.push(["s1", {}]);
    await test.registry.getCandidates();
    expect(test.counts.listProjects).toBe(2);
    expect(test.counts.tailReads).toBe(2);
  });
});
