import {
  type GlossaryArtifactResponse,
  type GlossaryPathChangedEvent,
  type GlossaryPathsSnapshotEvent,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { FakeSourceTransport } from "../transport/FakeSourceTransport";
import { GlossaryArtifactStore } from "./GlossaryArtifactStore";

const PROJECT_ID = toUrlProjectId("/projects/paper");

function readyResponse(
  sourceVersion: string,
  governingPath = "GLOSSARY.md",
): GlossaryArtifactResponse {
  return {
    artifact: {
      nodes: [{ failure: 0, outputs: [], transitions: {} }],
      sourceVersion,
      terminals: [],
      version: 1,
    },
    dependencies: [
      { contentHash: sourceVersion, path: governingPath, size: 12 },
    ],
    diagnostics: [],
    governingPath,
    sourceVersion,
    status: "ready",
  };
}

function snapshot(
  sequence: number,
  paths: string[],
): GlossaryPathsSnapshotEvent {
  return {
    type: "glossary-paths-snapshot",
    generation: { epoch: "server-1", sequence },
    paths,
    timestamp: "2026-08-04T00:00:00.000Z",
  };
}

function change(
  sequence: number,
  path: string,
  changeType: GlossaryPathChangedEvent["changeType"],
): GlossaryPathChangedEvent {
  return {
    type: "glossary-path-changed",
    changeType,
    generation: { epoch: "server-1", sequence },
    path,
    timestamp: "2026-08-04T00:00:01.000Z",
  };
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("GlossaryArtifactStore", () => {
  it("requests one source context without waiting for the path snapshot", async () => {
    const fetchMock = vi.fn();
    const fetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
      fetchMock(path, init);
      return readyResponse("v1", "papers/GLOSSARY.md") as T;
    };
    const transport = new FakeSourceTransport({ fetch });
    const store = new GlossaryArtifactStore();
    store.activate(PROJECT_ID, transport);
    store.ensure("papers/draft.md");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      `/projects/${encodeURIComponent(PROJECT_ID)}/glossary-artifact?sourcePath=papers%2Fdraft.md`,
      undefined,
    );
    await flush();
    expect(store.getSnapshot("papers/draft.md")).toMatchObject({
      state: "ready",
      result: { governingPath: "papers/GLOSSARY.md", sourceVersion: "v1" },
    });

    const subscription = transport.getSubscriptions("glossary")[0];
    expect(subscription?.projectId).toBe(PROJECT_ID);
    transport.openSubscription(subscription!.id);
    transport.emitSubscriptionEvent(
      subscription!.id,
      "glossary-paths-snapshot",
      snapshot(0, ["GLOSSARY.md", "papers/GLOSSARY.md"]),
    );
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot("papers/draft.md")).toMatchObject({
      state: "ready",
      result: { governingPath: "papers/GLOSSARY.md", sourceVersion: "v1" },
    });
  });

  it("uses one project subscription for every queried source directory", () => {
    const transport = new FakeSourceTransport();
    const store = new GlossaryArtifactStore();
    store.activate(PROJECT_ID, transport);

    for (let index = 0; index < 100; index += 1) {
      store.ensure(`papers/${index}/draft.md`);
    }

    expect(transport.getSubscriptions("glossary")).toHaveLength(1);
    expect(store.diagnostics().artifacts).toBe(100);
  });

  it("invalidates a dependent artifact after one glossary edit event", async () => {
    let fetchCount = 0;
    const fetchMock = vi.fn();
    const fetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
      fetchMock(path, init);
      fetchCount += 1;
      return readyResponse(
        fetchCount === 1 ? "v1" : "v2",
        "papers/GLOSSARY.md",
      ) as T;
    };
    const transport = new FakeSourceTransport({ fetch });
    const store = new GlossaryArtifactStore();
    store.activate(PROJECT_ID, transport);
    const unsubscribe = store.subscribe("papers/draft.md", () => {});
    store.ensure("papers/draft.md");
    const subscription = transport.getSubscriptions("glossary")[0]!;
    transport.emitSubscriptionEvent(
      subscription.id,
      "glossary-paths-snapshot",
      snapshot(0, ["papers/GLOSSARY.md"]),
    );
    await flush();

    transport.emitSubscriptionEvent(
      subscription.id,
      "glossary-path-changed",
      change(1, "papers/GLOSSARY.md", "modify"),
    );
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot("papers/draft.md")).toMatchObject({
      state: "ready",
      result: { sourceVersion: "v2" },
    });
    unsubscribe();
  });

  it("drops the old subscription and artifacts when the project changes", async () => {
    const transport = new FakeSourceTransport({
      fetch: async <T>() => readyResponse("v1") as T,
    });
    const store = new GlossaryArtifactStore();
    store.activate(PROJECT_ID, transport);
    store.ensure();
    const first = transport.getSubscriptions("glossary")[0]!;
    transport.emitSubscriptionEvent(
      first.id,
      "glossary-paths-snapshot",
      snapshot(0, ["GLOSSARY.md"]),
    );
    await flush();
    expect(store.getSnapshot().state).toBe("ready");

    const nextProjectId = toUrlProjectId("/projects/other");
    store.activate(nextProjectId, transport);

    expect(first.closed).toBe(false);
    expect(transport.getSubscriptions("glossary")[0]?.closed).toBe(true);
    expect(store.getSnapshot()).toEqual({ state: "idle" });
    expect(store.diagnostics()).toMatchObject({
      activeProjectId: nextProjectId,
      artifacts: 0,
    });
  });
});
