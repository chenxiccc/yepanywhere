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

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function responseBytes(response: GlossaryArtifactResponse): number {
  return new TextEncoder().encode(JSON.stringify(response)).byteLength;
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

  it("rejects a pre-snapshot completion after the first snapshot arrives", async () => {
    const first = deferred<GlossaryArtifactResponse>();
    const replacement = deferred<GlossaryArtifactResponse>();
    const fetchMock = vi.fn();
    const fetch = <T>(path: string, init?: RequestInit): Promise<T> => {
      fetchMock(path, init);
      return (
        fetchMock.mock.calls.length === 1 ? first.promise : replacement.promise
      ) as Promise<T>;
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

    expect(fetchMock).toHaveBeenCalledTimes(2);
    first.resolve(readyResponse("stale", "papers/GLOSSARY.md"));
    await flush();
    expect(store.getSnapshot("papers/draft.md")).toEqual({ state: "loading" });

    replacement.resolve(readyResponse("current", "papers/GLOSSARY.md"));
    await flush();
    expect(store.getSnapshot("papers/draft.md")).toMatchObject({
      state: "ready",
      result: { sourceVersion: "current" },
    });
    unsubscribe();
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

  it("keeps active and in-flight artifacts pinned outside inactive limits", async () => {
    const loading = deferred<GlossaryArtifactResponse>();
    const fetch = <T>(path: string): Promise<T> => {
      if (path.includes("loading.md")) return loading.promise as Promise<T>;
      return Promise.resolve(readyResponse("active")) as Promise<T>;
    };
    const transport = new FakeSourceTransport({ fetch });
    const store = new GlossaryArtifactStore({
      maxInactiveArtifacts: 0,
      maxInactiveBytes: 0,
    });
    store.activate(PROJECT_ID, transport);

    const releaseActive = store.subscribe("active.md", () => {});
    store.ensure("active.md");
    const releaseLoading = store.subscribe("loading.md", () => {});
    store.ensure("loading.md");
    releaseLoading();
    await flush();

    expect(store.diagnostics()).toMatchObject({
      artifacts: 2,
      inactiveArtifacts: 0,
      inactiveBytes: 0,
    });
    loading.resolve(readyResponse("loaded"));
    await flush();
    expect(store.getSnapshot("loading.md")).toEqual({ state: "idle" });
    expect(store.diagnostics().artifacts).toBe(1);

    releaseActive();
    expect(store.diagnostics().artifacts).toBe(0);
  });

  it("evicts the oldest inactive artifact and refetches it on revisit", async () => {
    const fetchMock = vi.fn();
    const fetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
      fetchMock(path, init);
      return readyResponse(path) as T;
    };
    const transport = new FakeSourceTransport({ fetch });
    const store = new GlossaryArtifactStore({
      maxInactiveArtifacts: 2,
      maxInactiveBytes: Number.MAX_SAFE_INTEGER,
    });
    store.activate(PROJECT_ID, transport);
    const visit = async (sourcePath: string) => {
      const unsubscribe = store.subscribe(sourcePath, () => {});
      store.ensure(sourcePath);
      await flush();
      expect(store.getSnapshot(sourcePath).state).toBe("ready");
      unsubscribe();
    };

    await visit("a.md");
    await visit("b.md");
    expect(store.getSnapshot("a.md").state).toBe("ready");
    await visit("c.md");

    expect(store.getSnapshot("a.md").state).toBe("ready");
    expect(store.getSnapshot("b.md")).toEqual({ state: "idle" });
    expect(store.getSnapshot("c.md").state).toBe("ready");
    expect(store.diagnostics().inactiveArtifacts).toBe(2);

    await visit("b.md");
    const bRequests = fetchMock.mock.calls.filter(([path]) =>
      String(path).includes("sourcePath=b.md"),
    );
    expect(bRequests).toHaveLength(2);
  });

  it("evicts inactive artifacts when their serialized bytes exceed the budget", async () => {
    const first = readyResponse("first-".repeat(40));
    const second = readyResponse("second-".repeat(40));
    const responses = [first, second];
    const fetch = async <T>(): Promise<T> => responses.shift() as T;
    const transport = new FakeSourceTransport({ fetch });
    const store = new GlossaryArtifactStore({
      maxInactiveArtifacts: 10,
      maxInactiveBytes: responseBytes(first) + responseBytes(second) - 1,
    });
    store.activate(PROJECT_ID, transport);
    const visit = async (sourcePath: string) => {
      const unsubscribe = store.subscribe(sourcePath, () => {});
      store.ensure(sourcePath);
      await flush();
      unsubscribe();
    };

    await visit("first.md");
    await visit("second.md");

    expect(store.getSnapshot("first.md")).toEqual({ state: "idle" });
    expect(store.getSnapshot("second.md").state).toBe("ready");
    expect(store.diagnostics()).toMatchObject({
      artifacts: 1,
      inactiveArtifacts: 1,
      inactiveBytes: responseBytes(second),
    });
  });

  it("reuses a subscribed root-governed file artifact for session prose", async () => {
    const fetchMock = vi.fn();
    const fetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
      fetchMock(path, init);
      return readyResponse("v1") as T;
    };
    const transport = new FakeSourceTransport({ fetch });
    const store = new GlossaryArtifactStore();
    store.activate(PROJECT_ID, transport);
    store.ensure("README.md");
    await flush();
    const subscription = transport.getSubscriptions("glossary")[0]!;
    transport.emitSubscriptionEvent(
      subscription.id,
      "glossary-paths-snapshot",
      snapshot(0, ["GLOSSARY.md"]),
    );
    await flush();

    store.ensure();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()).toMatchObject({
      state: "ready",
      result: { governingPath: "GLOSSARY.md", sourceVersion: "v1" },
    });
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
    await flush();
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
    const unsubscribe = store.subscribe(undefined, () => {});
    store.ensure();
    const first = transport.getSubscriptions("glossary")[0]!;
    transport.emitSubscriptionEvent(
      first.id,
      "glossary-paths-snapshot",
      snapshot(0, ["GLOSSARY.md"]),
    );
    await flush();
    expect(store.getSnapshot().state).toBe("ready");
    unsubscribe();
    expect(store.diagnostics().inactiveArtifacts).toBe(1);

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
