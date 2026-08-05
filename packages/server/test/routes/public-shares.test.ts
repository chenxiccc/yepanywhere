import {
  DEFAULT_RELAY_URL,
  type AppSession,
  type FileContentResponse,
  type UrlProjectId,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPublicSharePublicRoutes,
  createPublicShareRoutes,
  buildPublicSharePresentation,
} from "../../src/routes/public-shares.js";
import { createPublicShareManagementRoutes } from "../../src/routes/public-share-management.js";
import { PublicShareService } from "../../src/services/PublicShareService.js";
import { normalizeStartupEnv } from "../../src/startupEnv.js";

let projectId = "cHJvamVjdA" as UrlProjectId;

function makeSession(overrides: Partial<AppSession> = {}): AppSession {
  return {
    id: "session-1",
    projectId,
    title: "Test session",
    fullTitle: "Test session",
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:01:00.000Z",
    messageCount: 1,
    ownership: { owner: "self", processId: "proc-1" },
    provider: "codex",
    messages: [
      {
        type: "user",
        uuid: "message-1",
        message: { role: "user", content: "hello" },
        timestamp: "2026-05-01T00:00:00.000Z",
      },
    ],
    ...overrides,
  } as AppSession;
}

describe("public share public routes", () => {
  let service: PublicShareService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "public-share-routes-test-"),
    );
    const projectRoot = path.join(testDir, "project");
    await fs.mkdir(projectRoot);
    projectId = toUrlProjectId(projectRoot);
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.YEP_CLIENT_BASE_URL;
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("rejects incomplete frozen captures instead of leaking later turns", async () => {
    await expect(
      service.createShare({
        mode: "frozen",
        title: "Broken snapshot",
        source: {
          projectId,
          sessionId: "session-1",
          projectName: "project",
          provider: "codex",
        },
        snapshot: {
          ...makeSession({ messageCount: 2 }),
          messages: undefined,
        } as unknown as AppSession,
      }),
    ).rejects.toThrow(/missing its persisted messages/);
    expect(service.getValidShareCount()).toBe(0);
  });

  it("does not expose a public viewer heartbeat mutation route", async () => {
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request(`/${secret}/viewers/viewer-one`, {
      method: "POST",
    });

    expect(response.status).toBe(404);
    expect(
      service.getActiveViewerCount(service.getRecordBySecret(secret)!),
    ).toBe(0);
  });

  it("streams one frozen revision through the compact wire format", async () => {
    const snapshot = makeSession({ title: "Streamed snapshot" });
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot,
    });
    const materialize = vi.spyOn(service, "getFrozenShareBySecret");
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request(`/${secret}?wire=raw-json`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(
      "application/x-yep-public-share+json",
    );
    expect(body).toMatchObject({
      share: { mode: "frozen", title: "Snapshot" },
      session: { title: "Streamed snapshot" },
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("returns retryable unavailability while the control store is opening", async () => {
    const openingService = new PublicShareService({ dataDir: testDir });
    const app = createPublicSharePublicRoutes({
      publicShareService: openingService,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request(`/${"a".repeat(22)}/metadata`);
    await expect(response.json()).resolves.toMatchObject({
      retryable: true,
      storageState: "opening",
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("2");
  });

  it("does not resolve secret links when the feature is disabled", async () => {
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getPublicSharesEnabled: () => false,
    });

    const response = await app.request(`/${secret}`);

    expect(response.status).toBe(404);
  });

  it("serves files mentioned in the public share transcript", async () => {
    const projectRoot = path.join(testDir, "project");
    const publicProjectId = toUrlProjectId(projectRoot);
    const linkedPath = path.join(projectRoot, "ui-report", "README.md");
    const snapshot = makeSession({
      projectId: publicProjectId,
      messages: [
        {
          type: "assistant",
          uuid: "message-1",
          message: {
            role: "assistant",
            content: `See /api/local-file?path=${encodeURIComponent(linkedPath)}&render=1`,
          },
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId: publicProjectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot,
      presentation: await buildPublicSharePresentation(
        snapshot,
        projectRoot,
        publicProjectId,
      ),
    });
    const fileResponse: FileContentResponse = {
      metadata: {
        isText: true,
        mimeType: "text/markdown",
        path: "ui-report/README.md",
        size: 12,
      },
      content: "# Report",
      rawUrl: "/api/projects/project/files/raw?path=ui-report%2FREADME.md",
    };
    const fetchProjectFile = vi.fn(
      async () =>
        new Response(JSON.stringify(fileResponse), {
          headers: { "Content-Type": "application/json" },
        }),
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () =>
        makeSession({ projectId: publicProjectId }),
      ),
      getPublicSharesEnabled: () => true,
      fetchProjectFile,
    });

    const response = await app.request(
      `/${secret}/files?path=ui-report%2FREADME.md&highlight=true`,
    );
    const body = (await response.json()) as FileContentResponse;

    expect(response.status).toBe(200);
    expect(fetchProjectFile).toHaveBeenCalledWith(
      publicProjectId,
      "ui-report/README.md",
      { download: false, highlight: true, raw: false },
    );
    expect(body.content).toBe("# Report");
    expect(body.rawUrl).toBe(
      `/public-api/shares/${secret}/files/raw?path=ui-report%2FREADME.md`,
    );
  });

  it("serves render assets referenced by a mentioned markdown file", async () => {
    const projectRoot = path.join(testDir, "project");
    const publicProjectId = toUrlProjectId(projectRoot);
    const readmePath = path.join(projectRoot, "ui-report", "README.md");
    await fs.mkdir(path.dirname(readmePath), { recursive: true });
    await fs.writeFile(readmePath, "![plot](plot.png)\n", "utf-8");
    const snapshot = makeSession({
      projectId: publicProjectId,
      messages: [
        {
          type: "assistant",
          uuid: "message-1",
          message: {
            role: "assistant",
            content: `See /api/local-file?path=${encodeURIComponent(readmePath)}&render=1`,
          },
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId: publicProjectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot,
      presentation: await buildPublicSharePresentation(
        snapshot,
        projectRoot,
        publicProjectId,
      ),
    });
    const fetchProjectFile = vi.fn(
      async () =>
        new Response("image-bytes", {
          headers: { "Content-Type": "image/png" },
        }),
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () =>
        makeSession({ projectId: publicProjectId }),
      ),
      getPublicSharesEnabled: () => true,
      fetchProjectFile,
    });

    const response = await app.request(
      `/${secret}/files/raw?path=ui-report%2Fplot.png`,
    );

    expect(response.status).toBe(200);
    expect(fetchProjectFile).toHaveBeenCalledWith(
      publicProjectId,
      "ui-report/plot.png",
      { download: false, highlight: false, raw: true },
    );
    expect(await response.text()).toBe("image-bytes");
  });

  it("does not serve unmentioned project files through a share", async () => {
    const projectRoot = path.join(testDir, "project");
    const publicProjectId = toUrlProjectId(projectRoot);
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId: publicProjectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession({ projectId: publicProjectId }),
    });
    const fetchProjectFile = vi.fn();
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () =>
        makeSession({ projectId: publicProjectId }),
      ),
      getPublicSharesEnabled: () => true,
      fetchProjectFile,
    });

    const response = await app.request(`/${secret}/files?path=.env`);

    expect(response.status).toBe(404);
    expect(fetchProjectFile).not.toHaveBeenCalled();
  });

  it("keeps viewer-frozen file authorization at the captured manifest", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: { projectId, sessionId: "session-1" },
    });
    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "viewer-token-1",
      makeSession(),
      {
        presentation: { version: 1, authorizedPaths: ["old.md"] },
      },
    );
    const fetchProjectFile = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            metadata: {
              isText: true,
              mimeType: "text/markdown",
              path: "old.md",
              size: 3,
            },
            content: "old",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () =>
        makeSession({
          messages: [
            {
              type: "assistant",
              uuid: "message-new",
              message: { role: "assistant", content: "new.md" },
              timestamp: "2026-05-01T00:01:00.000Z",
            },
          ],
        }),
      ),
      getPublicSharesEnabled: () => true,
      fetchProjectFile,
    });

    const captured = await app.request(
      `/${secret}/files?path=old.md&viewerId=viewer-token-1`,
    );
    const later = await app.request(
      `/${secret}/files?path=new.md&viewerId=viewer-token-1`,
    );

    expect(captured.status).toBe(200);
    expect(later.status).toBe(404);
    expect(fetchProjectFile).toHaveBeenCalledTimes(1);
  });
});

describe("public share owner routes", () => {
  let service: PublicShareService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "public-share-owner-routes-test-"),
    );
    const projectRoot = path.join(testDir, "project");
    await fs.mkdir(projectRoot);
    projectId = toUrlProjectId(projectRoot);
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete process.env.YEP_CLIENT_BASE_URL;
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("blocks new share creation when the feature is disabled", async () => {
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => false,
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });

    expect(response.status).toBe(403);
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(0);
  });

  it("reports effective share creation readiness", async () => {
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayStatus: () => "connecting",
    });

    const response = await app.request("/status");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      enabled: true,
      configured: true,
      remoteAccessEnabled: true,
      relayStatus: "connecting",
      relayUrl: "wss://relay.example/ws",
      relayUsername: "host-one",
      canCreate: true,
      yaClientBaseUrl: "https://yepanywhere.com/remote",
      viewerBaseUrl: "https://yepanywhere.com/remote/share",
    });
  });

  it("creates new shares when the feature is enabled", async () => {
    const routeProjectId = projectId;
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () =>
        makeSession({ projectId: routeProjectId }),
      ),
      getRelayConfig: () => ({
        url: DEFAULT_RELAY_URL,
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayStatus: () => "waiting",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: routeProjectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain("https://yepanywhere.com/remote/share/");
    expect(body.url).toContain("?h=host-one");
    expect(new URL(body.url).searchParams.get("r")).toBeNull();
    const createdUrl = new URL(body.url);
    expect(createdUrl.hash).toBe("#v=2");
    expect(createdUrl.hash).not.toContain("Test session");
    expect(
      Buffer.from(createdUrl.pathname.split("/").at(-1)!, "base64url"),
    ).toHaveLength(16);
    expect(
      service.getSessionShareStatus(routeProjectId, "session-1").activeCount,
    ).toBe(1);

    const management = createPublicShareManagementRoutes({
      publicShareService: service,
    });
    const inventory = await management.request(
      `/public-shares?projectId=${routeProjectId}&sessionId=session-1`,
    );
    await expect(inventory.json()).resolves.toMatchObject({
      items: [{ shareId: body.shareId, url: body.url }],
      totalCount: 1,
    });
  });

  it("lists compact grants and revokes one opaque share id", async () => {
    await service.createShare({
      mode: "live",
      title: "Managed link",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const app = createPublicShareManagementRoutes({
      publicShareService: service,
    });

    const listResponse = await app.request(
      `/public-shares?projectId=${projectId}&sessionId=session-1`,
    );
    const list = await listResponse.json();

    expect(listResponse.status).toBe(200);
    expect(list).toMatchObject({ totalCount: 1, nextCursor: null });
    expect(list.items[0]).toMatchObject({
      mode: "live",
      title: "Managed link",
      sessionId: "session-1",
    });
    expect(list.items[0]).not.toHaveProperty("secretHash");

    const revokeResponse = await app.request(
      `/public-shares/${list.items[0].shareId}`,
      {
      method: "DELETE",
      },
    );
    expect(revokeResponse.status).toBe(200);
    await expect(revokeResponse.json()).resolves.toMatchObject({
      revoked: true,
    });
    expect(service.getValidShareCount()).toBe(0);
  });

  it("paginates management stably across a revocation", async () => {
    for (const title of ["first", "second", "third"]) {
      await service.createShare({
        mode: "live",
        title,
        source: {
          projectId,
          sessionId: `session-${title}`,
          projectName: "project",
          provider: "codex",
        },
      });
    }
    const app = createPublicShareManagementRoutes({
      publicShareService: service,
    });
    const firstResponse = await app.request("/public-shares?limit=1");
    const firstPage = await firstResponse.json();
    expect(firstPage.items).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    await app.request(`/public-shares/${firstPage.items[0].shareId}`, {
      method: "DELETE",
    });
    const secondResponse = await app.request(
      `/public-shares?limit=2&cursor=${encodeURIComponent(firstPage.nextCursor)}`,
    );
    const secondPage = await secondResponse.json();

    expect(secondPage.items).toHaveLength(2);
    expect(new Set(secondPage.items.map((item: { title: string }) => item.title))).toEqual(
      new Set(["first", "second", "third"].filter(
        (title) => title !== firstPage.items[0].title,
      )),
    );
    expect(secondPage.nextCursor).toBeNull();
  });

  it("requires explicit confirmation before global revocation", async () => {
    await service.createShare({
      mode: "live",
      title: "managed",
      source: { projectId, sessionId: "session-1" },
    });
    const app = createPublicShareManagementRoutes({
      publicShareService: service,
    });

    const rejected = await app.request("/public-shares/revoke-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "no" }),
    });
    expect(rejected.status).toBe(400);
    expect(service.getValidShareCount()).toBe(1);

    const revoked = await app.request("/public-shares/revoke-all", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirmation: "revoke-all-public-shares" }),
    });
    await expect(revoked.json()).resolves.toMatchObject({ revokedCount: 1 });
    expect(service.getValidShareCount()).toBe(0);
  });

  it("uses normalized user-turn provenance for context-shaped share prompts", async () => {
    const literalPrompt =
      "<environment_context>\nI typed this myself\n</environment_context>";
    const session = makeSession({
      messages: [
        {
          type: "user",
          uuid: "message-1",
          codexUserTurnProvenance: "paired",
          message: { role: "user", content: literalPrompt },
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => session),
      getRelayConfig: () => ({
        url: DEFAULT_RELAY_URL,
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayStatus: () => "waiting",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });
    const body = await response.json();
    const secret = new URL(body.url).pathname.split("/").at(-1)!;
    const publicRoutes = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => session),
      getPublicSharesEnabled: () => true,
    });
    const metadataResponse = await publicRoutes.request(`/${secret}/metadata`);
    const metadata = await metadataResponse.json();

    expect(response.status).toBe(200);
    expect(metadataResponse.status).toBe(200);
    expect(metadata.initialPrompt).toBe(
      "<environment_context> I typed this myself </environment_context>",
    );
  });

  it("creates new shares with a configured custom YA client URL", async () => {
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayStatus: () => "waiting",
      getYaClientBaseUrl: () => "shares.example/ya",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain("https://shares.example/ya/share/");
    expect(body.url).toContain("?h=host-one");
  });

  it("includes the configured custom relay in new share links", async () => {
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "relay.graehl.org",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayStatus: () => "waiting",
      getYaClientBaseUrl: () => "ya.graehl.org",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });
    const body = await response.json();
    const url = new URL(body.url);

    expect(response.status).toBe(200);
    expect(`${url.origin}${url.pathname}`).toContain(
      "https://ya.graehl.org/share/",
    );
    expect(url.searchParams.get("h")).toBe("host-one");
    expect(url.searchParams.get("r")).toBe("wss://relay.graehl.org/ws");
  });

  it("keeps legacy public share origin env compatibility", async () => {
    vi.stubEnv("YEP_PUBLIC_SHARE_ORIGIN", "https://ya.graehl.org");
    normalizeStartupEnv();
    expect(process.env.YEP_PUBLIC_SHARE_ORIGIN).toBeUndefined();
    expect(process.env.YEP_CLIENT_BASE_URL).toBe("https://ya.graehl.org");
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayStatus: () => "waiting",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.url).toContain("https://ya.graehl.org/share/");
  });

  it("blocks new share creation when remote access is disabled", async () => {
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => false,
      getRelayStatus: () => "waiting",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });

    expect(response.status).toBe(400);
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(0);
  });

  it("creates new shares while the relay is reconnecting", async () => {
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getRelayConfig: () => ({
        url: "wss://relay.example/ws",
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayStatus: () => "connecting",
    });

    const response = await app.request("/", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId,
        sessionId: "session-1",
        mode: "frozen",
      }),
    });

    expect(response.status).toBe(200);
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(1);
  });

  it("revokes all shares when requested by the settings kill switch", async () => {
    await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      snapshot: makeSession(),
    });
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(1);

    const revokedCount = await service.revokeAllShares();

    expect(revokedCount).toBe(1);
    expect(
      service.getSessionShareStatus(projectId, "session-1").activeCount,
    ).toBe(0);
  });
});
