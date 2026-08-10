import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteClientMessage } from "@yep-anywhere/shared";
import { api, fetchJSON } from "./client";
import {
  asClientSummarySourceKey,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../lib/clientSummaryStore";
import type { ConnectionManager } from "../lib/connection/ConnectionManager";
import { SecureSourceTransport } from "../lib/transport";
import {
  getSourceRuntimeRegistry,
  resetSourceRuntimeRegistryForTests,
} from "../lib/sourceRuntime";

class FakeSecureBackingConnection {
  readonly mode = "secure" as const;
  manager: ConnectionManager | null = null;
  readonly close = vi.fn();
  readonly sendPing = vi.fn();
  readonly sendMessage = vi.fn((_msg: RemoteClientMessage) => undefined);
  readonly forceReconnect = vi.fn(async () => {
    this.manager?.markConnected();
  });
  readonly fetchMock = vi.fn(
    async (path: string, init?: RequestInit): Promise<unknown> => ({
      path,
      init,
      via: "secure",
    }),
  );

  setConnectionManager(manager: ConnectionManager | null): void {
    this.manager = manager;
  }

  fetch<T>(path: string, init?: RequestInit): Promise<T> {
    return this.fetchMock(path, init) as Promise<T>;
  }
}

function resetApiRoutingState(): void {
  resetClientSummaryStoreForTests();
  resetSourceRuntimeRegistryForTests();
}

function okJsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("api.updateServerSettings", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({
        settings: {
          serviceWorkerEnabled: true,
          persistRemoteSessionsToDisk: false,
        },
      }),
    } as Response);

    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("serializes undefined setting values as null so clears reach the server", async () => {
    await api.updateServerSettings({
      globalInstructions: undefined,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, request] = fetchMock.mock.calls[0] ?? [];
    expect(request?.body).toBe(JSON.stringify({ globalInstructions: null }));
  });
});

describe("fetchJSON source transport routing", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("uses plain fetch semantics for the local source", async () => {
    fetchMock.mockResolvedValueOnce(okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchJSON("/projects")).resolves.toEqual({ ok: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/projects");
    expect(request?.credentials).toBe("include");
    const headers = request?.headers as Headers;
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("X-Yep-Anywhere")).toBe("true");
    expect(headers.get("X-Yep-Client-Version")).toBe("unknown");
  });

  it("routes remote attached fetches through the backing secure connection", async () => {
    const sourceKey = asClientSummarySourceKey("remote:attached");
    setCurrentClientSummarySourceKey(sourceKey);
    const transport = getSourceRuntimeRegistry().registerSourceTransport(
      sourceKey,
      { kind: "secure" },
    );
    expect(transport).toBeInstanceOf(SecureSourceTransport);
    const backing = new FakeSecureBackingConnection();
    (transport as SecureSourceTransport).attach(backing as never);

    await expect(
      fetchJSON("/auth/status", { method: "POST" }),
    ).resolves.toEqual({
      path: "/auth/status",
      init: { method: "POST" },
      via: "secure",
    });
    expect(backing.fetchMock).toHaveBeenCalledWith("/auth/status", {
      method: "POST",
    });
  });

  it("rejects detached remote fetches with a retryable typed timeout", async () => {
    vi.useFakeTimers();
    const sourceKey = asClientSummarySourceKey("remote:detached");
    setCurrentClientSummarySourceKey(sourceKey);
    getSourceRuntimeRegistry().registerSourceTransport(sourceKey, {
      kind: "secure",
      options: { readyTimeoutMs: 25 },
    });

    const pending = fetchJSON("/auth/status");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "SOURCE_TRANSPORT_NOT_READY",
      retryable: true,
      transportKind: "secure",
      channel: "secure-websocket",
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
  });
});

describe("api git facade", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    fetchMock.mockImplementation(async () => okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("preserves git endpoint paths and methods", async () => {
    await api.getGitStatus("project-a");
    await api.getGitUntrackedFolder("project-a", "src/a b.ts");
    await api.checkGitRemote("project-a");
    await api.getGitIntegrationOptions("project-a");
    await api.pullGit("project-a");
    await api.pushGit("project-a");
    await api.getGitDiff("project-a", {
      path: "src/a.ts",
      staged: false,
      status: "modified",
      fullContext: true,
      ignoreWhitespace: true,
    });
    await api.getGitComparison("project-a", "abc123");
    await api.getGitComparisonDiff("project-a", {
      baseSha: "abc123",
      headSha: "def456",
      path: "src/a.ts",
      status: "modified",
      ignoreWhitespace: true,
    });

    expect(
      fetchMock.mock.calls.map(([url, request]) => ({
        url,
        method: request?.method ?? "GET",
        body: request?.body,
      })),
    ).toEqual([
      { url: "/api/projects/project-a/git", method: "GET", body: undefined },
      {
        url: "/api/projects/project-a/git/untracked-folder?path=src%2Fa%20b.ts",
        method: "GET",
        body: undefined,
      },
      {
        url: "/api/projects/project-a/git/check-remote",
        method: "POST",
        body: undefined,
      },
      {
        url: "/api/projects/project-a/git/integration-options",
        method: "GET",
        body: undefined,
      },
      {
        url: "/api/projects/project-a/git/pull",
        method: "POST",
        body: undefined,
      },
      {
        url: "/api/projects/project-a/git/push",
        method: "POST",
        body: undefined,
      },
      {
        url: "/api/projects/project-a/git/diff",
        method: "POST",
        body: JSON.stringify({
          path: "src/a.ts",
          staged: false,
          status: "modified",
          fullContext: true,
          ignoreWhitespace: true,
        }),
      },
      {
        url: "/api/projects/project-a/git/compare/abc123",
        method: "GET",
        body: undefined,
      },
      {
        url: "/api/projects/project-a/git/compare-diff",
        method: "POST",
        body: JSON.stringify({
          baseSha: "abc123",
          headSha: "def456",
          path: "src/a.ts",
          status: "modified",
          ignoreWhitespace: true,
        }),
      },
    ]);
  });
});

describe("api auth facade", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    fetchMock.mockImplementation(async () => okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("preserves auth endpoint paths, methods, and bodies", async () => {
    await api.getAuthStatus();
    await api.enableAuth("enable-pw");
    await api.disableAuth();
    await api.setupAccount("setup-pw");
    await api.login("login-pw");
    await api.logout();
    await api.changePassword("new-pw");
    await api.setLocalhostAccess(true);

    expect(
      fetchMock.mock.calls.map(([url, request]) => ({
        url,
        method: request?.method ?? "GET",
        body: request?.body,
      })),
    ).toEqual([
      { url: "/api/auth/status", method: "GET", body: undefined },
      {
        url: "/api/auth/enable",
        method: "POST",
        body: JSON.stringify({ password: "enable-pw" }),
      },
      {
        url: "/api/auth/disable",
        method: "POST",
        body: undefined,
      },
      {
        url: "/api/auth/setup",
        method: "POST",
        body: JSON.stringify({ password: "setup-pw" }),
      },
      {
        url: "/api/auth/login",
        method: "POST",
        body: JSON.stringify({ password: "login-pw" }),
      },
      {
        url: "/api/auth/logout",
        method: "POST",
        body: undefined,
      },
      {
        url: "/api/auth/change-password",
        method: "POST",
        body: JSON.stringify({ newPassword: "new-pw" }),
      },
      {
        url: "/api/auth/localhost-access",
        method: "POST",
        body: JSON.stringify({ open: true }),
      },
    ]);
  });
});

describe("api recents facade", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    fetchMock.mockImplementation(async () => okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("preserves recents endpoint paths, methods, and bodies", async () => {
    await api.getRecents();
    await api.getRecents(25);
    await api.recordVisit("session-a", "project-a");
    await api.clearRecents();

    expect(
      fetchMock.mock.calls.map(([url, request]) => ({
        url,
        method: request?.method ?? "GET",
        body: request?.body,
      })),
    ).toEqual([
      { url: "/api/recents", method: "GET", body: undefined },
      { url: "/api/recents?limit=25", method: "GET", body: undefined },
      {
        url: "/api/recents/visit",
        method: "POST",
        body: JSON.stringify({
          sessionId: "session-a",
          projectId: "project-a",
        }),
      },
      {
        url: "/api/recents",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });
});

describe("api onboarding facade", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    fetchMock.mockImplementation(async () => okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("preserves onboarding endpoint paths and methods", async () => {
    await api.getOnboardingStatus();
    await api.completeOnboarding();
    await api.resetOnboarding();

    expect(
      fetchMock.mock.calls.map(([url, request]) => ({
        url,
        method: request?.method ?? "GET",
        body: request?.body,
      })),
    ).toEqual([
      { url: "/api/onboarding", method: "GET", body: undefined },
      {
        url: "/api/onboarding/complete",
        method: "POST",
        body: undefined,
      },
      {
        url: "/api/onboarding/reset",
        method: "POST",
        body: undefined,
      },
    ]);
  });
});

describe("api browser profiles facade", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    fetchMock.mockImplementation(async () => okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("preserves browser profile endpoint paths and methods", async () => {
    await api.getBrowserProfiles();
    await api.deleteBrowserProfile("browser profile/a");

    expect(
      fetchMock.mock.calls.map(([url, request]) => ({
        url,
        method: request?.method ?? "GET",
        body: request?.body,
      })),
    ).toEqual([
      { url: "/api/browser-profiles", method: "GET", body: undefined },
      {
        url: "/api/browser-profiles/browser%20profile%2Fa",
        method: "DELETE",
        body: undefined,
      },
    ]);
  });
});

describe("api server metadata facade", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    fetchMock.mockImplementation(async () => okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("preserves metadata endpoint paths and methods", async () => {
    await api.getVersion();
    await api.getVersion({ fresh: true });
    await api.getServerInfo();
    await api.getEnvSettings();
    await api.restartServer();

    expect(
      fetchMock.mock.calls.map(([url, request]) => ({
        url,
        method: request?.method ?? "GET",
        body: request?.body,
      })),
    ).toEqual([
      {
        url: "/api/version",
        method: "GET",
        body: undefined,
      },
      {
        url: "/api/version?fresh=1",
        method: "GET",
        body: undefined,
      },
      { url: "/api/server-info", method: "GET", body: undefined },
      { url: "/api/env-settings", method: "GET", body: undefined },
      {
        url: "/api/server/restart",
        method: "POST",
        body: undefined,
      },
    ]);
  });
});

describe("api push facade", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    fetchMock.mockImplementation(async () => okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("preserves push endpoint paths, methods, and bodies", async () => {
    const subscription = {
      endpoint: "https://push.example/subscription",
      keys: { p256dh: "p256dh-key", auth: "auth-key" },
    } satisfies PushSubscriptionJSON;
    const settings = {
      toolApproval: false,
      userQuestion: true,
    };

    await api.getPushPublicKey();
    await api.subscribePush("browser-a", subscription, "Laptop");
    await api.unsubscribePush("browser-a");
    await api.getPushSubscriptions();
    await api.testPush("browser-a", "Hello", "persistent", "high");
    await api.deletePushSubscription("browser profile/a");
    await api.getNotificationSettings();
    await api.updateNotificationSettings(settings);

    expect(
      fetchMock.mock.calls.map(([url, request]) => ({
        url,
        method: request?.method ?? "GET",
        body: request?.body,
      })),
    ).toEqual([
      { url: "/api/push/vapid-public-key", method: "GET", body: undefined },
      {
        url: "/api/push/subscribe",
        method: "POST",
        body: JSON.stringify({
          browserProfileId: "browser-a",
          subscription,
          deviceName: "Laptop",
        }),
      },
      {
        url: "/api/push/unsubscribe",
        method: "POST",
        body: JSON.stringify({ browserProfileId: "browser-a" }),
      },
      { url: "/api/push/subscriptions", method: "GET", body: undefined },
      {
        url: "/api/push/test",
        method: "POST",
        body: JSON.stringify({
          browserProfileId: "browser-a",
          message: "Hello",
          urgency: "persistent",
          deliveryUrgency: "high",
        }),
      },
      {
        url: "/api/push/subscriptions/browser%20profile%2Fa",
        method: "DELETE",
        body: undefined,
      },
      { url: "/api/push/settings", method: "GET", body: undefined },
      {
        url: "/api/push/settings",
        method: "PUT",
        body: JSON.stringify(settings),
      },
    ]);
  });
});

describe("api file facade", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    resetApiRoutingState();
    fetchMock.mockImplementation(async () => okJsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    window.history.replaceState({}, "", "/");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetApiRoutingState();
  });

  it("preserves file endpoint paths, methods, query params, and bodies", async () => {
    await api.getFile("project-a", "src/a b.ts");
    await api.getFile("project-a", "src/a b.ts", true, 10, 12, "range");
    const rawUrl = api.getFileRawUrl("project-a", "media/a b.png", true);
    await api.expandDiffContext(
      "project-a",
      "src/a.ts",
      "old",
      "new",
      "full file",
    );

    expect(rawUrl).toBe(
      "/api/projects/project-a/files/raw?path=media%2Fa+b.png&download=true",
    );
    expect(
      fetchMock.mock.calls.map(([url, request]) => ({
        url,
        method: request?.method ?? "GET",
        body: request?.body,
      })),
    ).toEqual([
      {
        url: "/api/projects/project-a/files?path=src%2Fa+b.ts",
        method: "GET",
        body: undefined,
      },
      {
        url: "/api/projects/project-a/files?path=src%2Fa+b.ts&highlight=true&line=10&lineEnd=12&view=range",
        method: "GET",
        body: undefined,
      },
      {
        url: "/api/projects/project-a/diff/expand",
        method: "POST",
        body: JSON.stringify({
          filePath: "src/a.ts",
          oldString: "old",
          newString: "new",
          originalFile: "full file",
        }),
      },
    ]);
  });
});
