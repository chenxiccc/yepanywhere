import {
  toUrlProjectId,
  type ProjectQueueItemSummary,
  type ProviderRuntimeStatus,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  asClientSummarySourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
  REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../clientSummaryStore";
import {
  createGlobalSessionsCollectionQueryDescriptor,
  selectInboxResponse,
  selectProjectCollectionRecords,
  selectProjectQueueItemsByProject,
  selectProviderRuntimeStatusForSession,
  selectSessionCollectionQueryRecords,
} from "../clientSummaryQueries";
import { createSessionDetailMemoryCache } from "../sessionDetail/sessionDetailStore";
import type { SessionRouteSnapshot } from "../sessionRouteSnapshots";
import {
  createSourceRuntimeRegistry,
  getOrCreateCurrentSourceRuntime,
  getSourceRuntimeRegistry,
  type SourceApiClient,
} from "../sourceRuntime";
import {
  FakeSourceTransport,
  LocalhostSourceTransport,
  SecureSourceTransport,
} from "../transport";
import { activityBus } from "../activityBus";

const apiMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getSessionMetadata: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: apiMocks,
}));

const RUNTIME_STATUS: Exclude<ProviderRuntimeStatus, null> = {
  kind: "retrying",
  provider: "claude",
  reason: "rate_limit",
  httpStatus: 429,
  startedAt: "2026-07-04T00:00:00.000Z",
  lastSeenAt: "2026-07-04T00:00:01.000Z",
  retryAt: "2026-07-04T00:01:00.000Z",
  retryDelayMs: 60_000,
  eventCount: 1,
  source: "claude.system.api_retry",
};

beforeEach(() => {
  resetClientSummaryStoreForTests();
  activityBus.resetForTests();
});

afterEach(() => {
  activityBus.resetForTests();
});

function fakeApiClient(): SourceApiClient {
  return {
    getSession: vi.fn(() => Promise.resolve({} as never)),
    getSessionMetadata: vi.fn(() => Promise.resolve({} as never)),
  };
}

function snapshot(sessionId: string, messageId: string): SessionRouteSnapshot {
  return {
    messages: [
      {
        uuid: messageId,
        type: "user",
        timestamp: "2026-07-05T00:00:00.000Z",
        message: { role: "user", content: messageId },
      },
    ],
    session: {
      id: sessionId,
      projectId: toUrlProjectId("/repo/project-a"),
      provider: "claude",
      title: sessionId,
      fullTitle: sessionId,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
      messageCount: 1,
      ownership: { owner: "none" },
    },
    agentContent: {},
    toolUseToAgentEntries: [],
    lastMessageId: messageId,
    maxPersistedTimestampMs: 0,
  };
}

function projectQueueItem(
  id: string,
  projectId: ProjectQueueItemSummary["projectId"],
): ProjectQueueItemSummary {
  return {
    id,
    projectId,
    target: { type: "existing-session", sessionId: "session-a" },
    messagePreview: `Message ${id}`,
    message: { text: `Message ${id}` },
    createdAt: "2026-07-05T00:00:00.000Z",
    updatedAt: "2026-07-05T00:00:00.000Z",
    status: "queued",
    attachmentCount: 0,
  };
}

describe("source runtime session detail API", () => {
  beforeEach(() => {
    apiMocks.getSession.mockReset();
    apiMocks.getSessionMetadata.mockReset();
  });

  it("forwards bounded session-detail requests", async () => {
    apiMocks.getSession.mockResolvedValueOnce({ ok: true });
    const runtime = getOrCreateCurrentSourceRuntime(
      LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    );

    await runtime.api.getSession({
      projectId: "proj-1",
      sessionId: "sess-1",
      tailCompactions: 2,
    });

    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      undefined,
      { tailCompactions: 2 },
    );
  });

  it("keeps full-history reads explicit without changing the server request", async () => {
    apiMocks.getSession.mockResolvedValueOnce({ ok: true });
    const runtime = getOrCreateCurrentSourceRuntime(
      LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    );

    await runtime.api.getSession({
      projectId: "proj-1",
      sessionId: "sess-1",
      fullHistory: true,
      fullHistoryReason: "test explicit full-history escape hatch",
    });

    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      undefined,
      {
        fullHistory: true,
        fullHistoryReason: "test explicit full-history escape hatch",
      },
    );
  });

  it("allows explicit full-history scope to be narrowed server-side", async () => {
    apiMocks.getSession.mockResolvedValueOnce({ ok: true });
    const runtime = getOrCreateCurrentSourceRuntime(
      LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    );

    await runtime.api.getSession({
      projectId: "proj-1",
      sessionId: "sess-1",
      fullHistory: true,
      fullHistoryReason: "test explicit full-history turn window",
      tailTurns: 20,
    });

    expect(apiMocks.getSession).toHaveBeenCalledWith(
      "proj-1",
      "sess-1",
      undefined,
      {
        fullHistory: true,
        fullHistoryReason: "test explicit full-history turn window",
        tailTurns: 20,
      },
    );
  });

  it("rejects unbounded session-detail requests without explicit full history", () => {
    const runtime = getOrCreateCurrentSourceRuntime(
      LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    );

    expect(() =>
      runtime.api.getSession({
        projectId: "proj-1",
        sessionId: "sess-1",
      } as never),
    ).toThrow(
      "Session detail request requires bounds or explicit fullHistory.",
    );
    expect(apiMocks.getSession).not.toHaveBeenCalled();
  });

  it("rejects full-history requests without a reason", () => {
    const runtime = getOrCreateCurrentSourceRuntime(
      LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
    );

    expect(() =>
      runtime.api.getSession({
        projectId: "proj-1",
        sessionId: "sess-1",
        fullHistory: true,
        fullHistoryReason: "",
      }),
    ).toThrow("Full-history session request requires a reason.");
    expect(apiMocks.getSession).not.toHaveBeenCalled();
  });

  it("keeps the current-source helper on the default registry path", () => {
    const sourceKey = asClientSummarySourceKey("host:compat");

    expect(getOrCreateCurrentSourceRuntime(sourceKey)).toBe(
      getSourceRuntimeRegistry().getOrCreateSourceRuntime(sourceKey),
    );
  });
});

describe("SourceRuntimeRegistry", () => {
  it("returns stable runtimes per source key and separate runtimes across keys", () => {
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const sourceA = asClientSummarySourceKey("host:a");
    const sourceB = asClientSummarySourceKey("host:b");

    const runtimeA = registry.getOrCreateSourceRuntime(sourceA);

    expect(registry.getOrCreateSourceRuntime(sourceA)).toBe(runtimeA);
    expect(registry.getOrCreateSourceRuntime(sourceA).transport).toBe(
      runtimeA.transport,
    );
    expect(registry.getOrCreateSourceRuntime(sourceB)).not.toBe(runtimeA);
    expect(registry.getOrCreateSourceRuntime(sourceB).sourceKey).toBe(sourceB);
  });

  it("uses explicit transport registrations without parsing source keys", () => {
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      defaultTransportRegistration: { kind: "localhost" },
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const sourceKey = asClientSummarySourceKey("host:opaque-remote-looking");

    const runtime = registry.getOrCreateSourceRuntime(sourceKey);
    expect(runtime.transport).toBeInstanceOf(LocalhostSourceTransport);

    const transport = registry.registerSourceTransport(sourceKey, {
      kind: "secure",
    });
    expect(transport).toBeInstanceOf(SecureSourceTransport);
    expect(registry.getOrCreateSourceRuntime(sourceKey).transport).toBe(
      transport,
    );
  });

  it("keeps repeated matching transport registrations idempotent", () => {
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const sourceKey = asClientSummarySourceKey("server:stable");

    const first = registry.registerSourceTransport(sourceKey, {
      kind: "secure",
    });
    const second = registry.registerSourceTransport(sourceKey, {
      kind: "secure",
    });

    expect(second).toBe(first);
  });

  it("resolves remote:none to a detached secure transport", () => {
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });

    const runtime = registry.getOrCreateSourceRuntime(
      REMOTE_NONE_CLIENT_SUMMARY_SOURCE_KEY,
    );

    expect(runtime.transport).toBeInstanceOf(SecureSourceTransport);
    expect(runtime.transport.status.getSnapshot()).toMatchObject({
      kind: "secure",
      state: "disconnected",
    });
  });

  it("retains activity through a non-current source runtime", () => {
    const sourceA = asClientSummarySourceKey("host:activity-a");
    const sourceB = asClientSummarySourceKey("host:activity-b");
    const transportA = new FakeSourceTransport();
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    registry.registerSourceTransport(sourceA, {
      kind: "custom",
      createTransport: () => transportA,
    });
    const runtimeA = registry.getOrCreateSourceRuntime(sourceA);

    setCurrentClientSummarySourceKey(sourceB);
    const release = runtimeA.summary.retainActivitySubscription();

    expect(transportA.getSubscriptions("activity")).toHaveLength(1);

    release();
    expect(transportA.getSubscriptions("activity")[0]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
  });

  it("routes current-source helpers through the registry source key", () => {
    const sourceA = asClientSummarySourceKey("host:a");
    const sourceB = asClientSummarySourceKey("host:b");
    let currentSourceKey = sourceA;
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
      getCurrentSourceKey: () => currentSourceKey,
      setCurrentSourceKey: (sourceKey) => {
        currentSourceKey = sourceKey;
      },
    });

    expect(registry.getCurrentSourceRuntime().sourceKey).toBe(sourceA);

    registry.setCurrentSourceKey(sourceB);

    expect(registry.getCurrentSourceRuntime().sourceKey).toBe(sourceB);
  });

  it("keeps session-detail cache entries isolated by source key", () => {
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const sourceA = asClientSummarySourceKey("host:a");
    const sourceB = asClientSummarySourceKey("host:b");
    const runtimeA = registry.getOrCreateSourceRuntime(sourceA);
    const runtimeB = registry.getOrCreateSourceRuntime(sourceB);
    const projectId = "project-a";
    const sessionId = "session-a";

    runtimeA.sessionDetails.cache.writeRouteSnapshot(
      { sourceKey: sourceA, projectId, sessionId },
      snapshot(sessionId, "msg-a"),
    );

    expect(
      runtimeB.sessionDetails.cache.readRouteSnapshot({
        sourceKey: sourceB,
        projectId,
        sessionId,
      }),
    ).toBeUndefined();
    expect(
      runtimeA.sessionDetails.cache.readRouteSnapshot({
        sourceKey: sourceA,
        projectId,
        sessionId,
      })?.lastMessageId,
    ).toBe("msg-a");
  });

  it("binds summary store access and status reports to the source key", () => {
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const sourceA = asClientSummarySourceKey("host:summary-a");
    const sourceB = asClientSummarySourceKey("host:summary-b");
    const runtimeA = registry.getOrCreateSourceRuntime(sourceA);
    const runtimeB = registry.getOrCreateSourceRuntime(sourceB);

    expect(runtimeA.summary.sourceKey).toBe(sourceA);
    expect(runtimeA.summary.getStore()).toBe(runtimeA.summary.getStore());
    expect(runtimeA.summary.getStore()).not.toBe(runtimeB.summary.getStore());

    runtimeA.summary.reportProviderRuntimeStatusSnapshot(
      {
        sessionId: "session-a",
        projectId: "project-a",
        providerRuntimeStatus: RUNTIME_STATUS,
      },
      100,
    );

    expect(
      selectProviderRuntimeStatusForSession(
        runtimeA.summary.getSnapshot(),
        "session-a",
      ),
    ).toEqual(RUNTIME_STATUS);
    expect(
      selectProviderRuntimeStatusForSession(
        runtimeB.summary.getSnapshot(),
        "session-a",
      ),
    ).toBe(null);

    runtimeA.summary.clear();

    expect(
      selectProviderRuntimeStatusForSession(
        runtimeA.summary.getSnapshot(),
        "session-a",
      ),
    ).toBe(null);
  });

  it("binds summary collection writers to the source key", () => {
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const sourceA = asClientSummarySourceKey("host:collection-a");
    const sourceB = asClientSummarySourceKey("host:collection-b");
    const runtimeA = registry.getOrCreateSourceRuntime(sourceA);
    const runtimeB = registry.getOrCreateSourceRuntime(sourceB);
    const projectId = toUrlProjectId("/repo/project-a");
    const query = createGlobalSessionsCollectionQueryDescriptor({});

    runtimeA.summary.reportGlobalSessionsCollectionSnapshot(
      {
        query,
        sessions: [
          {
            id: "session-a",
            title: "Session A",
            fullTitle: "Session A",
            createdAt: "2026-07-05T00:00:00.000Z",
            updatedAt: "2026-07-05T00:00:00.000Z",
            messageCount: 1,
            provider: "claude",
            projectId,
            projectName: "Project A",
            ownership: { owner: "none" },
            isArchived: false,
            isStarred: false,
          },
        ],
        hasMore: false,
      },
      100,
    );
    runtimeA.summary.reportInboxCollectionSnapshot(
      {
        needsAttention: [
          {
            sessionId: "session-a",
            projectId,
            projectName: "Project A",
            sessionTitle: "Session A",
            updatedAt: "2026-07-05T00:00:00.000Z",
          },
        ],
        active: [],
        recentActivity: [],
        unread8h: [],
        unread24h: [],
      },
      100,
    );
    runtimeA.summary.reportProjectsCollectionSnapshot(
      {
        projects: [
          {
            id: projectId,
            path: "/repo/project-a",
            name: "Project A",
            sessionCount: 1,
            activeOwnedCount: 0,
            activeExternalCount: 0,
            lastActivity: null,
          },
        ],
      },
      100,
    );
    runtimeA.summary.reportProjectQueueCollectionSnapshot(
      {
        projectId,
        items: [projectQueueItem("queue-a", projectId)],
      },
      100,
    );

    expect(
      selectSessionCollectionQueryRecords(
        runtimeA.summary.getSnapshot(),
        query,
      ).map((record) => record.id),
    ).toEqual(["session-a"]);
    expect(
      selectSessionCollectionQueryRecords(
        runtimeB.summary.getSnapshot(),
        query,
      ),
    ).toEqual([]);
    expect(
      selectInboxResponse(runtimeA.summary.getSnapshot()).needsAttention.map(
        (item) => item.sessionId,
      ),
    ).toEqual(["session-a"]);
    expect(
      selectInboxResponse(runtimeB.summary.getSnapshot()).needsAttention,
    ).toEqual([]);
    expect(
      selectProjectCollectionRecords(runtimeA.summary.getSnapshot()).map(
        (project) => project.id,
      ),
    ).toEqual([projectId]);
    expect(
      selectProjectQueueItemsByProject(runtimeA.summary.getSnapshot(), [
        projectId,
      ])[projectId]?.map((item) => item.id),
    ).toEqual(["queue-a"]);
    expect(
      selectProjectQueueItemsByProject(runtimeB.summary.getSnapshot(), [
        projectId,
      ])[projectId],
    ).toBeUndefined();
  });

  it("disposes the source transport for a disposed runtime", () => {
    const transports: FakeSourceTransport[] = [];
    const registry = createSourceRuntimeRegistry({
      apiClient: fakeApiClient(),
      defaultTransportRegistration: {
        kind: "custom",
        createTransport: () => {
          const transport = new FakeSourceTransport();
          vi.spyOn(transport, "dispose");
          transports.push(transport);
          return transport;
        },
      },
      sessionDetails: { cache: createSessionDetailMemoryCache() },
    });
    const sourceKey = asClientSummarySourceKey("host:disposed");
    const first = registry.getOrCreateSourceRuntime(sourceKey);

    registry.disposeSource(sourceKey);

    expect(transports[0]?.dispose).toHaveBeenCalledTimes(1);
    const second = registry.getOrCreateSourceRuntime(sourceKey);
    expect(second).not.toBe(first);
    expect(second.sourceKey).toBe(sourceKey);
    expect(second.transport).toBe(transports[1]);
  });
});
