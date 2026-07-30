import { describe, expect, it, vi } from "vitest";
import type { SavedHost } from "../hostStorage";
import {
  type MultiHostMonitorConnection,
  type MultiHostMonitorConnectionSnapshot,
  MultiHostMonitorController,
  MultiHostSignInRequiredError,
} from "../multiHostMonitor";

function savedHost(id: string, session = true): SavedHost {
  return {
    id,
    displayName: id.toUpperCase(),
    mode: "relay",
    relayUrl: "ws://relay.test/ws",
    relayUsername: id,
    srpUsername: id,
    session: session
      ? {
          wsUrl: "ws://relay.test/ws",
          username: id,
          sessionId: `session-${id}`,
          sessionKey: "session-key",
          resumeProtocolVersion: 3,
        }
      : undefined,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

class FakeConnection implements MultiHostMonitorConnection {
  private readonly listeners = new Set<() => void>();
  readonly dispose = vi.fn();
  snapshot: MultiHostMonitorConnectionSnapshot;

  constructor(
    state: MultiHostMonitorConnectionSnapshot["state"],
    title: string,
  ) {
    this.snapshot = {
      state,
      summary: {
        activeAgentCount: 0,
        hasMoreSessions: false,
        needsAttentionCount: 0,
        sessions: [{ id: "shared-session", title }],
      },
    };
  }

  getSnapshot = () => this.snapshot;

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  update(state: MultiHostMonitorConnectionSnapshot["state"]): void {
    this.snapshot = { ...this.snapshot, state };
    for (const listener of this.listeners) listener();
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

describe("MultiHostMonitorController", () => {
  it("publishes progressive readiness and keeps colliding ids source-scoped", async () => {
    const alpha = deferred<MultiHostMonitorConnection>();
    const beta = deferred<MultiHostMonitorConnection>();
    const alphaConnection = new FakeConnection("ready", "Alpha marker");
    const betaConnection = new FakeConnection("ready", "Beta marker");
    const controller = new MultiHostMonitorController(
      [savedHost("alpha"), savedHost("beta")],
      (host) => (host.id === "alpha" ? alpha.promise : beta.promise),
    );
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.start();
    expect(controller.getSnapshot()).toMatchObject({
      connectedCount: 0,
      selectedCount: 2,
    });

    alpha.resolve(alphaConnection);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().connectedCount).toBe(1);
    });
    expect(
      controller.getSnapshot().hosts[0]?.summary?.sessions[0],
    ).toMatchObject({
      id: "shared-session",
      title: "Alpha marker",
    });

    beta.resolve(betaConnection);
    await vi.waitFor(() => {
      expect(controller.getSnapshot().connectedCount).toBe(2);
    });
    expect(
      controller.getSnapshot().hosts[1]?.summary?.sessions[0],
    ).toMatchObject({
      id: "shared-session",
      title: "Beta marker",
    });
    expect(listener).toHaveBeenCalled();

    controller.dispose();
    expect(alphaConnection.dispose).toHaveBeenCalledOnce();
    expect(betaConnection.dispose).toHaveBeenCalledOnce();
  });

  it("isolates offline and sign-in-required hosts", async () => {
    const connected = new FakeConnection("ready", "Healthy");
    const controller = new MultiHostMonitorController(
      [savedHost("healthy"), savedHost("offline"), savedHost("expired")],
      async (host) => {
        if (host.id === "healthy") return connected;
        if (host.id === "expired") {
          throw new MultiHostSignInRequiredError("Session expired");
        }
        throw new Error("server_offline");
      },
    );

    controller.start();
    await vi.waitFor(() => {
      expect(
        controller.getSnapshot().hosts.map((host) => [host.hostId, host.state]),
      ).toEqual([
        ["healthy", "connected"],
        ["offline", "offline"],
        ["expired", "sign-in-required"],
      ]);
    });
    expect(controller.getSnapshot().connectedCount).toBe(1);
  });

  it("does not connect a host without a saved session", () => {
    const connector = vi.fn();
    const controller = new MultiHostMonitorController(
      [savedHost("needs-login", false)],
      connector,
    );

    controller.start();

    expect(connector).not.toHaveBeenCalled();
    expect(controller.getSnapshot().hosts[0]?.state).toBe("sign-in-required");
  });

  it("tracks a later disconnect without changing healthy peers", async () => {
    const alpha = new FakeConnection("ready", "Alpha");
    const beta = new FakeConnection("ready", "Beta");
    const controller = new MultiHostMonitorController(
      [savedHost("alpha"), savedHost("beta")],
      async (host) => (host.id === "alpha" ? alpha : beta),
    );
    controller.start();
    await vi.waitFor(() => {
      expect(controller.getSnapshot().connectedCount).toBe(2);
    });

    alpha.update("disconnected");

    expect(controller.getSnapshot().connectedCount).toBe(1);
    expect(controller.getSnapshot().hosts).toMatchObject([
      { hostId: "alpha", state: "offline" },
      { hostId: "beta", state: "connected" },
    ]);
  });

  it("disposes a late connection after route teardown", async () => {
    const pending = deferred<MultiHostMonitorConnection>();
    const connection = new FakeConnection("ready", "Late");
    const controller = new MultiHostMonitorController(
      [savedHost("late")],
      () => pending.promise,
    );
    controller.start();
    controller.dispose();

    pending.resolve(connection);
    await pending.promise;
    await Promise.resolve();

    expect(connection.dispose).toHaveBeenCalledOnce();
  });
});
