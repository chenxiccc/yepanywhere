import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  asClientSummarySourceKey,
  type ClientSummarySourceKey,
} from "../../clientSummaryStore";
import type { SessionRouteSnapshot } from "../../sessionRouteSnapshots";
import {
  createSessionDetailMemoryCache,
  createSessionDetailStore,
  defaultSessionDetailMemoryCache,
  defaultSessionDetailStore,
  getSessionDetailEntryKey,
  SessionDetailMemoryCache,
  type SessionDetailEntryKeyInput,
} from "../sessionDetailStore";

const SOURCE_A = asClientSummarySourceKey("host:a");
const SOURCE_B = asClientSummarySourceKey("host:b");
const PROJECT_ID = toUrlProjectId("/repo/project-a");

function key(
  sessionId: string,
  sourceKey: ClientSummarySourceKey = SOURCE_A,
): SessionDetailEntryKeyInput {
  return {
    sourceKey,
    projectId: "project-a",
    sessionId,
  };
}

function snapshot(
  sessionId: string,
  messageIds: readonly string[],
): SessionRouteSnapshot {
  return {
    messages: messageIds.map((uuid) => ({
      uuid,
      type: "user",
      timestamp: "2026-06-30T00:00:00.000Z",
      message: { role: "user", content: uuid },
    })),
    session: {
      id: sessionId,
      projectId: PROJECT_ID,
      provider: "claude",
      title: sessionId,
      fullTitle: sessionId,
      createdAt: "2026-06-30T00:00:00.000Z",
      updatedAt: "2026-06-30T00:00:00.000Z",
      messageCount: messageIds.length,
      ownership: { owner: "none" },
    },
    agentContent: {},
    toolUseToAgentEntries: [],
    lastMessageId: messageIds[messageIds.length - 1],
    maxPersistedTimestampMs: 0,
  };
}

describe("SessionDetailMemoryCache", () => {
  it("keeps staged store compatibility aliases wired to the memory cache", () => {
    expect(createSessionDetailMemoryCache()).toBeInstanceOf(
      SessionDetailMemoryCache,
    );
    expect(createSessionDetailStore()).toBeInstanceOf(SessionDetailMemoryCache);
    expect(defaultSessionDetailStore).toBe(defaultSessionDetailMemoryCache);
  });

  it("stores route snapshots under source-scoped keys with stats", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    expect(
      store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]), {
        nowMs: 10,
      }),
    ).toBe(true);

    expect(
      store.readRouteSnapshot(storeKey, { nowMs: 11 })?.lastMessageId,
    ).toBe("msg-1");
    expect(store.readRouteSnapshot(key("session-a", SOURCE_B))).toBeUndefined();
    expect(getSessionDetailEntryKey(storeKey)).toBe(
      "host%3Aa:project-a:session-a",
    );

    const stats = store.getStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.approxBytes).toBeGreaterThan(0);
    expect(stats.entries[0]).toMatchObject({
      key: "host%3Aa:project-a:session-a",
      sourceKey: SOURCE_A,
      projectId: "project-a",
      sessionId: "session-a",
      messageCount: 1,
      retainCount: 0,
      createdAt: 10,
      updatedAt: 10,
      lastAccessedAt: 11,
    });
  });

  it("separates retained live bytes from warm cache bytes in stats", () => {
    const store = createSessionDetailMemoryCache();
    const warmKey = key("warm-session");
    const liveKey = key("live-session");

    store.writeRouteSnapshot(warmKey, snapshot("warm-session", ["warm-msg"]));
    store.writeRouteSnapshot(liveKey, snapshot("live-session", ["live-msg"]));
    const release = store.retain(liveKey);

    const stats = store.getStats();
    const warmEntry = stats.entries.find(
      (entry) => entry.key === getSessionDetailEntryKey(warmKey),
    );
    const liveEntry = stats.entries.find(
      (entry) => entry.key === getSessionDetailEntryKey(liveKey),
    );

    expect(stats.entryCount).toBe(2);
    expect(stats.retainedEntryCount).toBe(1);
    expect(stats.warmCacheEntryCount).toBe(1);
    expect(stats.retainedApproxBytes).toBe(liveEntry?.approxBytes);
    expect(stats.warmCacheApproxBytes).toBe(warmEntry?.approxBytes);
    expect(stats.approxBytes).toBe(
      stats.retainedApproxBytes + stats.warmCacheApproxBytes,
    );
    expect(stats.retainedDedupedApproxBytes).toBeGreaterThan(0);
    expect(stats.warmCacheDedupedApproxBytes).toBeGreaterThan(0);

    release();
  });

  it("notifies selector subscribers only when the selected value changes", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");
    let notifications = 0;
    const unsubscribe = store.subscribe(
      storeKey,
      (state) => state?.messages.length ?? 0,
      () => {
        notifications += 1;
      },
    );

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]));
    expect(notifications).toBe(1);

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-2"]));
    expect(notifications).toBe(1);

    store.writeRouteSnapshot(
      storeKey,
      snapshot("session-a", ["msg-2", "msg-3"]),
    );
    expect(notifications).toBe(2);

    unsubscribe();
    store.writeRouteSnapshot(
      storeKey,
      snapshot("session-a", ["msg-2", "msg-3", "msg-4"]),
    );
    expect(notifications).toBe(2);
  });

  it("stores an atomically trimmed loaded window in route snapshots", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("trimmed-session");
    const source = snapshot("trimmed-session", ["msg-1", "msg-2", "msg-3"]);
    source.pagination = {
      hasOlderMessages: false,
      totalMessageCount: 3,
      returnedMessageCount: 3,
      totalCompactions: 0,
      totalUserTurns: 3,
    };
    store.replaceRouteSnapshot(storeKey, source);
    const beforeTrimStats = store.getStats().entries[0];

    store.dispatch(storeKey, {
      type: "trimLoadedWindow",
      startMessageId: "msg-2",
      reason: "user_turn",
      nowMs: Date.parse("2026-07-10T12:00:00.000Z"),
    });

    const retained = store.readRouteSnapshot(storeKey);
    expect(retained?.messages.map((entry) => entry.uuid)).toEqual([
      "msg-2",
      "msg-3",
    ]);
    expect(retained?.pagination).toEqual({
      hasOlderMessages: true,
      totalMessageCount: 3,
      returnedMessageCount: 2,
      truncatedBeforeMessageId: "msg-2",
      totalCompactions: 0,
      totalUserTurns: 3,
      truncatedBy: "user_turn",
    });
    const afterTrimStats = store.getStats().entries[0];
    expect(afterTrimStats?.messageCount).toBe(2);
    expect(afterTrimStats?.approxBytes).toBeLessThan(
      beforeTrimStats?.approxBytes ?? 0,
    );
  });

  it("keeps subscription-only entries out of stats", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");
    const source = snapshot("session-a", ["msg-1"]);
    const streamMessage = source.messages[0];
    if (!streamMessage) throw new Error("expected fixture message");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let notifications = 0;

    const unsubscribe = store.subscribe(
      storeKey,
      (state) => state?.messages.length ?? 0,
      () => {
        notifications += 1;
      },
    );

    try {
      expect(store.getStats().entryCount).toBe(0);
      expect(
        store.dispatch(storeKey, {
          type: "applyStreamMessage",
          message: streamMessage,
        }),
      ).toBeUndefined();
      expect(store.getStats().entryCount).toBe(0);
      expect(notifications).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        "[SessionDetailStore] dropped action for missing entry",
        {
          key: "host%3Aa:project-a:session-a",
          actionType: "applyStreamMessage",
        },
      );

      store.writeRouteSnapshot(storeKey, source);
      expect(store.getStats().entryCount).toBe(1);
      expect(notifications).toBe(1);
    } finally {
      unsubscribe();
      warn.mockRestore();
    }
  });

  it("reads selected state without exposing the whole entry", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    store.writeRouteSnapshot(
      storeKey,
      snapshot("session-a", ["msg-1", "msg-2"]),
    );

    expect(
      store.readSelected(storeKey, (state) =>
        state.messages.map((message) => message.uuid),
      ),
    ).toEqual(["msg-1", "msg-2"]);
    expect(
      store.readSelected(key("missing"), (state) => state.messages.length),
    ).toBeUndefined();
  });

  it("keeps explicit tail variants separate from the default session entry", () => {
    const store = createSessionDetailMemoryCache();
    const defaultKey = key("session-a");
    const tailTurnsKey = {
      ...defaultKey,
      tailTurns: 5,
    };
    const tailFromKey = {
      ...defaultKey,
      tailFrom: "msg-2",
    };

    store.writeRouteSnapshot(
      defaultKey,
      snapshot("session-a", ["msg-1", "msg-2", "msg-3"]),
    );
    store.writeRouteSnapshot(
      tailTurnsKey,
      snapshot("session-a", ["msg-2", "msg-3"]),
    );
    store.writeRouteSnapshot(tailFromKey, snapshot("session-a", ["msg-3"]));

    expect(
      store
        .readRouteSnapshot(defaultKey)
        ?.messages.map((message) => message.uuid),
    ).toEqual(["msg-1", "msg-2", "msg-3"]);
    expect(
      store
        .readRouteSnapshot(tailTurnsKey)
        ?.messages.map((message) => message.uuid),
    ).toEqual(["msg-2", "msg-3"]);
    expect(
      store
        .readRouteSnapshot(tailFromKey)
        ?.messages.map((message) => message.uuid),
    ).toEqual(["msg-3"]);
    expect(getSessionDetailEntryKey(tailTurnsKey)).toBe(
      "host%3Aa:project-a:session-a?tailTurns=5",
    );
    expect(getSessionDetailEntryKey(tailFromKey)).toBe(
      "host%3Aa:project-a:session-a?tailFrom=msg-2",
    );

    expect(
      store
        .getStats()
        .entries.map((entry) => ({
          key: entry.key,
          messageCount: entry.messageCount,
          tailTurns: entry.tailTurns,
          tailFrom: entry.tailFrom,
        }))
        .sort((left, right) => left.key.localeCompare(right.key)),
    ).toEqual([
      {
        key: "host%3Aa:project-a:session-a",
        messageCount: 3,
        tailTurns: undefined,
        tailFrom: undefined,
      },
      {
        key: "host%3Aa:project-a:session-a?tailFrom=msg-2",
        messageCount: 1,
        tailTurns: undefined,
        tailFrom: "msg-2",
      },
      {
        key: "host%3Aa:project-a:session-a?tailTurns=5",
        messageCount: 2,
        tailTurns: 5,
        tailFrom: undefined,
      },
    ]);
  });

  it("deletes a single entry without clearing unrelated entries", () => {
    const store = createSessionDetailMemoryCache();

    store.writeRouteSnapshot(key("one"), snapshot("one", ["one"]));
    store.writeRouteSnapshot(key("two"), snapshot("two", ["two"]));

    expect(store.deleteEntry(key("one"))).toBe(true);
    expect(store.deleteEntry(key("missing"))).toBe(false);
    expect(store.readRouteSnapshot(key("one"))).toBeUndefined();
    expect(store.readRouteSnapshot(key("two"))?.lastMessageId).toBe("two");
  });

  it("keeps scroll snapshots outside ordinary selector subscriptions", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");
    let notifications = 0;

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]));
    store.subscribe(
      storeKey,
      (state) => state?.messages.length ?? -1,
      () => {
        notifications += 1;
      },
    );

    store.patchScrollSnapshot(storeKey, {
      atBottom: true,
      scrollTop: 42,
      scrollHeight: 400,
      clientHeight: 200,
      updatedAtMs: 10,
    });

    expect(notifications).toBe(0);
    expect(store.readScrollSnapshot(storeKey)?.scrollTop).toBe(42);
    expect(store.readRouteSnapshot(storeKey)?.scrollSnapshot?.scrollTop).toBe(
      42,
    );

    store.patchScrollSnapshot(
      storeKey,
      {
        atBottom: false,
        scrollTop: 100,
        scrollHeight: 400,
        clientHeight: 200,
        updatedAtMs: 20,
      },
      { notify: true },
    );

    expect(notifications).toBe(0);
    expect(store.readScrollSnapshot(storeKey)?.scrollTop).toBe(100);
  });

  it("keeps retained entries through a warm-cache clear", () => {
    const store = createSessionDetailMemoryCache();
    const retainedKey = key("live-session");
    const warmKey = key("warm-session");

    store.writeRouteSnapshot(retainedKey, snapshot("live-session", ["msg-1"]));
    store.writeRouteSnapshot(warmKey, snapshot("warm-session", ["msg-2"]));
    const release = store.retain(retainedKey);

    store.clear();

    expect(store.readRouteSnapshot(warmKey)).toBeUndefined();
    expect(store.readRouteSnapshot(retainedKey)?.lastMessageId).toBe("msg-1");
    expect(store.getStats().entries[0]?.retainCount).toBe(1);

    release();
  });

  it("returns an identity-stable scroll snapshot between patches", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]));
    store.patchScrollSnapshot(storeKey, {
      atBottom: false,
      scrollTop: 42,
      scrollHeight: 400,
      clientHeight: 200,
      updatedAtMs: 10,
    });

    const first = store.readScrollSnapshot(storeKey);
    expect(first?.scrollTop).toBe(42);
    expect(store.readScrollSnapshot(storeKey)).toBe(first);

    store.patchScrollSnapshot(storeKey, {
      atBottom: false,
      scrollTop: 50,
      scrollHeight: 400,
      clientHeight: 200,
      updatedAtMs: 20,
    });

    const second = store.readScrollSnapshot(storeKey);
    expect(second).not.toBe(first);
    expect(second?.scrollTop).toBe(50);
  });

  it("retains entries through expiry until released", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]), {
      ttlMs: 10,
      nowMs: 0,
    });
    store.retain(storeKey, { ttlMs: 10, nowMs: 1 });

    expect(store.evictExpired({ nowMs: 11 })).toBe(0);
    expect(store.readRouteSnapshot(storeKey, { nowMs: 11 })).toBeDefined();

    store.release(storeKey, { ttlMs: 10, nowMs: 12 });

    expect(store.evictExpired({ nowMs: 21 })).toBe(0);
    expect(store.evictExpired({ nowMs: 23 })).toBe(1);
    expect(store.readRouteSnapshot(storeKey, { nowMs: 23 })).toBeUndefined();
  });

  it("rejects over-budget snapshots without deleting retained entries", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]), {
      nowMs: 0,
    });
    const release = store.retain(storeKey, { nowMs: 1 });

    expect(
      store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-2"]), {
        maxBytes: 1,
        nowMs: 2,
      }),
    ).toBe(false);
    expect(
      store
        .readRouteSnapshot(storeKey, { nowMs: 3 })
        ?.messages.map((message) => message.uuid),
    ).toEqual(["msg-1"]);
    expect(store.getStats().entries[0]?.retainCount).toBe(1);

    release();
  });

  it("rejects over-budget snapshots and clears unretained cache records", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]), {
      nowMs: 0,
    });

    expect(
      store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-2"]), {
        maxBytes: 1,
        nowMs: 1,
      }),
    ).toBe(false);
    expect(store.readRouteSnapshot(storeKey, { nowMs: 2 })).toBeUndefined();
  });

  it("replaces retained active snapshots outside cache admission budget", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]), {
      nowMs: 0,
    });
    const release = store.retain(storeKey, { nowMs: 1 });

    expect(
      store.replaceRouteSnapshot(storeKey, snapshot("session-a", ["msg-2"]), {
        maxBytes: 1,
        nowMs: 2,
      }),
    ).toBe(true);
    expect(
      store
        .readRouteSnapshot(storeKey, { nowMs: 3 })
        ?.messages.map((message) => message.uuid),
    ).toEqual(["msg-2"]);

    const stats = store.getStats();
    expect(stats.entries[0]?.retainCount).toBe(1);
    expect(stats.entries[0]?.approxBytes).toBeGreaterThan(1);

    release();
  });

  it("does not evict the active replacement target before retain attaches", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    expect(
      store.replaceRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]), {
        maxBytes: 1,
        nowMs: 0,
      }),
    ).toBe(true);

    expect(
      store
        .readRouteSnapshot(storeKey, { nowMs: 1 })
        ?.messages.map((message) => message.uuid),
    ).toEqual(["msg-1"]);
  });

  it("drops incremental actions for a missing entry instead of fabricating state", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");
    const source = snapshot("session-a", ["msg-1"]);
    const streamMessage = source.messages[0];
    if (!streamMessage) throw new Error("expected fixture message");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      expect(
        store.dispatch(storeKey, {
          type: "applyStreamMessage",
          message: streamMessage,
        }),
      ).toBeUndefined();
      expect(store.getStats().entryCount).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        "[SessionDetailStore] dropped action for missing entry",
        {
          key: "host%3Aa:project-a:session-a",
          actionType: "applyStreamMessage",
        },
      );
    } finally {
      warn.mockRestore();
    }

    expect(
      store.dispatch(storeKey, {
        type: "loadPersistedTranscript",
        messages: source.messages,
        session: source.session,
      }),
    ).toBeDefined();
    expect(store.getStats().entryCount).toBe(1);
  });

  it("does not resurrect an expired entry from a later stream dispatch", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");
    const source = snapshot("session-a", ["msg-1", "msg-2"]);
    const streamMessage = source.messages[0];
    if (!streamMessage) throw new Error("expected fixture message");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    store.writeRouteSnapshot(storeKey, source, { ttlMs: 10, nowMs: 0 });
    // Unretained entry expires; the read deletes it.
    expect(store.readRouteSnapshot(storeKey, { nowMs: 20 })).toBeUndefined();

    try {
      expect(
        store.dispatch(
          storeKey,
          { type: "applyStreamMessage", message: streamMessage },
          { nowMs: 21 },
        ),
      ).toBeUndefined();
      expect(store.getStats().entryCount).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        "[SessionDetailStore] dropped action for missing entry",
        {
          key: "host%3Aa:project-a:session-a",
          actionType: "applyStreamMessage",
        },
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("resets entry state in place without dropping retention", () => {
    const store = createSessionDetailMemoryCache();
    const storeKey = key("session-a");

    store.writeRouteSnapshot(storeKey, snapshot("session-a", ["msg-1"]), {
      nowMs: 0,
    });
    store.retain(storeKey, { nowMs: 1 });

    store.resetEntryState(storeKey, { nowMs: 2 });

    const stats = store.getStats();
    expect(stats.entryCount).toBe(1);
    expect(stats.entries[0]?.retainCount).toBe(1);
    expect(stats.entries[0]?.messageCount).toBe(0);
    expect(store.readSelected(storeKey, (state) => state.session)).toBeNull();
  });

  it("keeps retained entries out of LRU eviction candidates", () => {
    const store = createSessionDetailMemoryCache();

    store.writeRouteSnapshot(key("one"), snapshot("one", ["one"]), {
      maxEntries: 2,
      nowMs: 0,
    });
    store.retain(key("one"), { nowMs: 1 });
    store.writeRouteSnapshot(key("two"), snapshot("two", ["two"]), {
      maxEntries: 2,
      nowMs: 2,
    });
    store.writeRouteSnapshot(key("three"), snapshot("three", ["three"]), {
      maxEntries: 2,
      nowMs: 3,
    });

    expect(store.readRouteSnapshot(key("one"), { nowMs: 4 })).toBeDefined();
    expect(store.readRouteSnapshot(key("two"), { nowMs: 4 })).toBeUndefined();
    expect(store.readRouteSnapshot(key("three"), { nowMs: 4 })).toBeDefined();
  });
});
