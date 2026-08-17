import type { HttpBindings } from "@hono/node-server";
import {
  DEFAULT_RELAY_URL,
  PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION,
  PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
  PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
  PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES,
  type AppAssistantMessage,
  type AppSession,
  type AppUserMessage,
  type FileContentResponse,
  type PublicSessionShareResponse,
  type RelayResponse,
  type UrlProjectId,
  type YepMessage,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gunzipSync } from "node:zlib";
import { Hono } from "hono";
import { compress } from "hono/compress";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLogger } from "../../src/logging/logger.js";
import {
  createPublicSharePublicRoutes,
  createPublicShareRoutes,
  buildPublicSharePresentation,
} from "../../src/routes/public-shares.js";
import { createPublicShareManagementFreezeRoutes } from "../../src/routes/public-share-management-freeze.js";
import { createPublicShareManagementRoutes } from "../../src/routes/public-share-management.js";
import {
  LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES,
  createConnectionState,
  handleRequest,
} from "../../src/routes/ws-relay-handlers.js";
import {
  LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
  PublicShareService,
} from "../../src/services/PublicShareService.js";
import { PublicShareStore } from "../../src/services/PublicShareStore.js";
import { normalizeStartupEnv } from "../../src/startupEnv.js";

let projectId = "cHJvamVjdA" as UrlProjectId;

const appMessageBase = {
  isSidechain: false,
  userType: "external" as const,
  cwd: "/project",
  sessionId: "session-1",
  version: "2.1.0",
  uuid: "00000000-0000-4000-8000-000000000001",
  parentUuid: null,
  timestamp: "2026-05-01T00:00:00.000Z",
};

function makeUserMessage(
  content: string,
  overrides: Partial<AppUserMessage> = {},
): AppUserMessage {
  return {
    ...appMessageBase,
    type: "user",
    message: { role: "user", content },
    ...overrides,
  };
}

function makeAssistantMessage(
  content: string,
  overrides: Partial<AppAssistantMessage> = {},
): AppAssistantMessage {
  return {
    ...appMessageBase,
    type: "assistant",
    message: {
      id: "assistant-message-1",
      type: "message",
      role: "assistant",
      model: "test-model",
      content: [{ type: "text", text: content }],
      usage: { input_tokens: 0, output_tokens: 0 },
    },
    ...overrides,
  };
}

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
    messages: [makeUserMessage("hello")],
    ...overrides,
  };
}

async function captureSession(
  service: PublicShareService,
  session = makeSession(),
) {
  const capture = await service.captureCompleteSession(async () => session);
  if (!capture) throw new Error("Expected test session capture");
  return capture;
}

function streamedJsonRequest(url: string, body: unknown): Request {
  const encoded = new TextEncoder().encode(JSON.stringify(body));
  let offset = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= encoded.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + 4_096, encoded.byteLength);
      controller.enqueue(encoded.slice(offset, end));
      offset = end;
    },
  });
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  } as RequestInit & { duplex: "half" });
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
      service.captureCompleteSession(
        async () =>
          ({
            ...makeSession({ messageCount: 2 }),
            messages: undefined,
          }) as unknown as AppSession,
      ),
    ).rejects.toThrow(/complete session history is unavailable/i);
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
      capture: await captureSession(service),
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
      capture: await captureSession(service, snapshot),
    });
    const materialize = vi.spyOn(service, "getFrozenShareBySecret");
    const readRevisionSession = vi.spyOn(
      PublicShareStore.prototype,
      "readRevisionSession",
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request(`/${secret}?wire=raw-json`);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.byteLength).toBeLessThanOrEqual(
        LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
      );
      chunks.push(next.value);
    }
    const body = JSON.parse(
      new TextDecoder().decode(Buffer.concat(chunks)),
    ) as PublicSessionShareResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain(
      "application/x-yep-public-share+json",
    );
    expect(body).toMatchObject({
      share: { mode: "frozen", title: "Snapshot" },
      session: { title: "Streamed snapshot" },
    });
    expect(materialize).not.toHaveBeenCalled();
    expect(readRevisionSession).not.toHaveBeenCalled();
  });

  it("streams an unmarked combined response in bounded source chunks", async () => {
    const content = randomBytes(100_000).toString("base64");
    const snapshot = makeSession({
      messages: [makeUserMessage(content)],
    });
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Legacy combined snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service, snapshot),
    });
    const readRevisionSession = vi.spyOn(
      PublicShareStore.prototype,
      "readRevisionSession",
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request(`/${secret}`);
    const reader = response.body!.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      expect(next.value.byteLength).toBeLessThanOrEqual(
        LEGACY_PUBLIC_SHARE_RESPONSE_CHUNK_MAX_BYTES,
      );
      chunks.push(next.value);
    }
    const body = JSON.parse(
      new TextDecoder().decode(Buffer.concat(chunks)),
    ) as PublicSessionShareResponse;

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("application/json");
    expect(chunks.length).toBeGreaterThan(1);
    expect(body.session.messages[0]).toMatchObject({
      message: { content },
    });
    expect(readRevisionSession).not.toHaveBeenCalled();
  });

  it("caps an oversized legacy response from the real public route", async () => {
    const warn = vi
      .spyOn(getLogger(), "warn")
      .mockImplementation(() => undefined);
    const snapshot = makeSession({
      messages: [
        makeUserMessage("x".repeat(LEGACY_PUBLIC_SHARE_RELAY_MAX_BYTES)),
      ],
    });
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Oversized legacy snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service, snapshot),
    });
    const publicRoutes = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
    });
    const app = new Hono<{ Bindings: HttpBindings }>();
    app.use("/public-api/*", compress());
    app.route("/public-api/shares", publicRoutes);
    const sent: YepMessage[] = [];

    await handleRequest(
      {
        type: "request",
        id: "legacy-oversized",
        method: "GET",
        path: `/public-api/shares/${secret}`,
        headers: { "Accept-Encoding": "gzip" },
      },
      (message) => sent.push(message),
      { send: () => undefined, close: () => undefined },
      app,
      "http://localhost",
      createConnectionState(),
    );

    expect(sent).toHaveLength(1);
    expect(sent[0] as RelayResponse).toMatchObject({
      type: "response",
      status: 413,
      body: { retryable: false, updateRequired: true },
    });
    expect(warn).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "[WS Relay] Public share response capped: method=GET, kind=legacy-session, status=200, bytes=",
      ),
    );
  });

  it("advertises and pulls one immutable frozen revision in bounded chunks", async () => {
    const snapshot = makeSession({
      title: "Bounded snapshot",
      messages: [
        {
          type: "user",
          isSidechain: false,
          userType: "external",
          cwd: "/project",
          sessionId: "session-1",
          version: "2.1.0",
          uuid: "00000000-0000-4000-8000-000000000001",
          parentUuid: null,
          message: {
            role: "user",
            content: randomBytes(400_000).toString("base64"),
          },
          timestamp: "2026-05-01T00:00:00.000Z",
        },
      ],
    });
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service, snapshot),
    });
    const materialize = vi.spyOn(service, "getFrozenShareBySecret");
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
    });

    const metadataResponse = await app.request(
      `/${secret}/metadata?viewerId=viewer-bounded`,
    );
    const metadata = await metadataResponse.json();
    expect(metadataResponse.status).toBe(200);
    expect(metadata.capabilities).toEqual([
      PUBLIC_SHARE_SESSION_CHUNKS_CAPABILITY,
    ]);
    expect(metadata.sessionChunks.maxChunkBytes).toBe(
      PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
    );

    const compressed: Uint8Array[] = [];
    let cursor: string | null = null;
    let expectedOffset = 0;
    let expectedIndex = 0;
    while (true) {
      const params = new URLSearchParams({ viewerId: "viewer-bounded" });
      if (cursor) params.set("cursor", cursor);
      const response = await app.request(`/${secret}/session-chunks?${params}`);
      expect(response.status).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(bytes.byteLength).toBeGreaterThan(0);
      expect(bytes.byteLength).toBeLessThanOrEqual(
        PUBLIC_SHARE_SESSION_CHUNK_MAX_BYTES,
      );
      expect(response.headers.get("X-Yep-Public-Share-Chunk-Index")).toBe(
        String(expectedIndex),
      );
      expect(response.headers.get("X-Yep-Public-Share-Chunk-Offset")).toBe(
        String(expectedOffset),
      );
      expectedOffset += bytes.byteLength;
      expect(response.headers.get("X-Yep-Public-Share-Next-Offset")).toBe(
        String(expectedOffset),
      );
      expect(response.headers.get("X-Yep-Public-Share-Revision")).toBe(
        metadata.sessionChunks.revisionId,
      );
      expect(response.headers.get("X-Yep-Public-Share-Integrity")).toBe(
        metadata.sessionChunks.integrityWitness,
      );
      compressed.push(bytes);
      expectedIndex += 1;
      if (response.headers.get("X-Yep-Public-Share-Final") === "true") {
        expect(
          response.headers.get("X-Yep-Public-Share-Next-Cursor"),
        ).toBeNull();
        break;
      }
      cursor = response.headers.get("X-Yep-Public-Share-Next-Cursor");
      expect(cursor).toEqual(expect.any(String));
    }

    expect(compressed.length).toBeGreaterThan(1);
    expect(expectedOffset).toBe(metadata.sessionChunks.compressedBytes);
    const joined = Buffer.concat(compressed.map((bytes) => Buffer.from(bytes)));
    expect(JSON.parse(gunzipSync(joined).toString("utf-8"))).toEqual({
      ...snapshot,
      ownership: { owner: "none" },
    });
    expect(materialize).not.toHaveBeenCalled();
  });

  it("selects frozen viewer metadata and ignores inherited snapshot names", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live share",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
    });
    const viewerSession = makeSession({
      title: "Viewer snapshot",
      updatedAt: "2026-05-01T00:04:00.000Z",
    });
    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "__proto__",
      await captureSession(service, viewerSession),
    );
    const record = service.getRecordBySecret(secret)!;
    expect(
      Object.getOwnPropertyDescriptor(
        record.viewerSnapshots ?? {},
        "__proto__",
      ),
    ).toBeDefined();
    expect(service.hasViewerSnapshot(record, "constructor")).toBe(false);

    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () =>
        makeSession({ title: "Current live session" }),
      ),
      getPublicSharesEnabled: () => true,
    });
    const viewerMetadataResponse = await app.request(
      `/${secret}/metadata?viewerId=__proto__`,
    );
    const viewerMetadata = await viewerMetadataResponse.json();
    const liveMetadataResponse = await app.request(
      `/${secret}/metadata?viewerId=constructor`,
    );
    const liveMetadata = await liveMetadataResponse.json();
    const viewerResponse = await app.request(`/${secret}?viewerId=__proto__`);
    const liveResponse = await app.request(`/${secret}?viewerId=constructor`);

    expect(viewerMetadataResponse.status).toBe(200);
    expect(viewerMetadata).toMatchObject({
      mode: "frozen",
      capturedAt: viewerMetadata.sessionChunks.capturedAt,
      linkedFileMode: viewerMetadata.sessionChunks.linkedFileMode,
    });
    expect(liveMetadataResponse.status).toBe(200);
    expect(liveMetadata).toMatchObject({ mode: "live" });
    expect(liveMetadata).not.toHaveProperty("sessionChunks");
    await expect(viewerResponse.json()).resolves.toMatchObject({
      share: {
        mode: "frozen",
        capturedAt: viewerMetadata.capturedAt,
        linkedFileMode: viewerMetadata.linkedFileMode,
      },
      session: { title: "Viewer snapshot" },
    });
    await expect(liveResponse.json()).resolves.toMatchObject({
      share: { mode: "live" },
      session: { title: "Current live session" },
    });

    await service.disconnectSessionViewerToken(
      projectId,
      "session-1",
      "__proto__",
    );
    expect(
      service.hasViewerSnapshot(
        service.getRecordBySecret(secret)!,
        "__proto__",
      ),
    ).toBe(false);
  });

  it("omits bounded transfer for an oversized historical revision", async () => {
    const { secret, record } = await service.createShare({
      mode: "frozen",
      title: "Historical snapshot",
      source: {
        projectId,
        sessionId: "session-1",
        projectName: "project",
        provider: "codex",
      },
      capture: await captureSession(service),
    });
    const revisionId = record.revisionId!;
    const statePath = path.join(
      testDir,
      "public-shares",
      "shares",
      record.shareStateId,
      "state.json",
    );
    const state = JSON.parse(await fs.readFile(statePath, "utf8")) as {
      revisions: Record<string, { compressedBytes: number }>;
    };
    state.revisions[revisionId]!.compressedBytes =
      PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES + 1;
    await fs.writeFile(statePath, JSON.stringify(state), "utf8");
    await fs.truncate(
      path.join(
        testDir,
        "public-shares",
        "shares",
        record.shareStateId,
        "frozen",
        revisionId,
        "session.json.gz",
      ),
      PUBLIC_SHARE_SESSION_COMPRESSED_MAX_BYTES + 1,
    );
    const readChunk = vi.spyOn(
      PublicShareStore.prototype,
      "readRevisionCompressedChunk",
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
    });

    const metadataResponse = await app.request(`/${secret}/metadata`);
    const metadata = await metadataResponse.json();
    const chunkResponse = await app.request(`/${secret}/session-chunks`);

    expect(metadataResponse.status).toBe(200);
    expect(metadata).not.toHaveProperty("capabilities");
    expect(metadata).not.toHaveProperty("sessionChunks");
    expect(chunkResponse.status).toBe(409);
    await expect(chunkResponse.json()).resolves.toMatchObject({
      retryable: false,
      updateRequired: true,
    });
    expect(readChunk).not.toHaveBeenCalled();
  });

  it("rejects only the selected broken frozen representation", async () => {
    const snapshot = makeSession({
      messages: [makeAssistantMessage("See note.md")],
    });
    const { secret } = await service.createShare({
      mode: "frozen",
      title: "Scoped repair",
      source: { projectId, sessionId: "session-1" },
      capture: {
        ...(await captureSession(service, snapshot)),
        presentation: { version: 1, authorizedPaths: ["note.md"] },
      },
    });
    const record = service.getRecordBySecret(secret)!;
    record.primaryAvailability = "repair-required";
    record.viewerSnapshots = {
      "viewer-good": {
        capturedAt: record.capturedAt!,
        revisionId: record.revisionId!,
        linkedFileMode: record.linkedFileMode!,
        snapshotBytes: record.snapshotBytes!,
        availability: "available",
      },
    };
    const fetchProjectFile = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            metadata: {
              isText: true,
              mimeType: "text/markdown",
              path: "note.md",
              size: 4,
            },
            content: "note",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getPublicSharesEnabled: () => true,
      fetchProjectFile,
    });

    const metadata = await app.request(`/${secret}/metadata`);
    const primary = await app.request(`/${secret}`);
    const viewer = await app.request(`/${secret}?viewerId=viewer-good`);
    const primaryFile = await app.request(`/${secret}/files?path=note.md`);
    const viewerFile = await app.request(
      `/${secret}/files?path=note.md&viewerId=viewer-good`,
    );

    expect(metadata.status).toBe(200);
    expect(primary.status).toBe(503);
    await expect(primary.json()).resolves.toMatchObject({
      repairRequired: true,
      retryable: false,
    });
    expect(viewer.status).toBe(200);
    expect(primaryFile.status).toBe(503);
    expect(viewerFile.status).toBe(200);
  });

  it("keeps a live primary available when one viewer revision is broken", async () => {
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live with broken viewer",
      source: { projectId, sessionId: "session-1" },
    });
    await service.freezeSessionViewerToken(
      projectId,
      "session-1",
      "viewer-broken",
      await captureSession(service),
    );
    const record = service.getRecordBySecret(secret)!;
    record.viewerSnapshots!["viewer-broken"]!.availability = "repair-required";
    record.repairRequired = true;
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      getPublicSharesEnabled: () => true,
    });

    const primary = await app.request(`/${secret}`);
    const viewer = await app.request(`/${secret}?viewerId=viewer-broken`);

    expect(primary.status).toBe(200);
    expect(viewer.status).toBe(503);
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

  it("does not expose failed storage diagnostics to public viewers", async () => {
    const invalidDataDir = path.join(testDir, "not-a-directory");
    await fs.writeFile(invalidDataDir, "file");
    const failedService = new PublicShareService({ dataDir: invalidDataDir });
    await expect(failedService.initialize()).rejects.toThrow();
    const app = createPublicSharePublicRoutes({
      publicShareService: failedService,
      loadSession: vi.fn(async () => null),
      getPublicSharesEnabled: () => true,
    });

    const response = await app.request(`/${"a".repeat(22)}/metadata`);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body).toMatchObject({
      error: "Public share storage is unavailable",
      retryable: false,
      storageState: "failed",
    });
    expect(JSON.stringify(body)).not.toContain(invalidDataDir);
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
      capture: await captureSession(service),
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
        makeAssistantMessage(
          `See /api/local-file?path=${encodeURIComponent(linkedPath)}&render=1`,
        ),
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
      capture: {
        ...(await captureSession(service, snapshot)),
        presentation: await buildPublicSharePresentation(
          snapshot,
          projectRoot,
          publicProjectId,
        ),
      },
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
        makeAssistantMessage(
          `See /api/local-file?path=${encodeURIComponent(readmePath)}&render=1`,
        ),
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
      capture: {
        ...(await captureSession(service, snapshot)),
        presentation: {
          version: 1,
          authorizedPaths: ["ui-report/README.md", "ui-report/plot.png"],
        },
      },
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

  it("matches live share file authorization by exact relative path", async () => {
    const projectRoot = path.join(testDir, "project");
    const publicProjectId = toUrlProjectId(projectRoot);
    const session = makeSession({
      projectId: publicProjectId,
      messages: [makeAssistantMessage("See config.env")],
    });
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: { projectId: publicProjectId, sessionId: "session-1" },
    });
    const fetchProjectFile = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            metadata: {
              isText: true,
              mimeType: "text/plain",
              path: "config.env",
              size: 6,
            },
            content: "public",
          }),
          { headers: { "Content-Type": "application/json" } },
        ),
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => session),
      getPublicSharesEnabled: () => true,
      fetchProjectFile,
    });

    const substring = await app.request(`/${secret}/files?path=.env`);
    const exact = await app.request(`/${secret}/files?path=config.env`);

    expect(substring.status).toBe(404);
    expect(exact.status).toBe(200);
    expect(fetchProjectFile).toHaveBeenCalledOnce();
    expect(fetchProjectFile).toHaveBeenCalledWith(
      publicProjectId,
      "config.env",
      { download: false, highlight: false, raw: false },
    );
  });

  it("authorizes mentioned app-data attachments on live shares", async () => {
    const projectRoot = path.join(testDir, "project");
    const dataDir = path.join(testDir, "data");
    const publicProjectId = toUrlProjectId(projectRoot);
    const attachmentPath = path.join(
      dataDir,
      "projects",
      "0123456789abcdef0123456789abcdef",
      "attachments",
      "session-a",
      "photo.png",
    );
    await fs.mkdir(path.dirname(attachmentPath), { recursive: true });
    await fs.writeFile(attachmentPath, "png-bytes");
    const session = makeSession({
      projectId: publicProjectId,
      messages: [makeAssistantMessage(`Read ${attachmentPath}`)],
    });
    const { secret } = await service.createShare({
      mode: "live",
      title: "Live",
      source: { projectId: publicProjectId, sessionId: "session-1" },
    });
    const fetchProjectFile = vi.fn(
      async () =>
        new Response("png-bytes", {
          headers: { "Content-Type": "image/png" },
        }),
    );
    const app = createPublicSharePublicRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => session),
      getPublicSharesEnabled: () => true,
      fetchProjectFile,
      dataDir,
    });

    const response = await app.request(
      `/${secret}/files/raw?path=${encodeURIComponent(attachmentPath)}`,
    );

    expect(response.status).toBe(200);
    expect(fetchProjectFile).toHaveBeenCalledWith(
      publicProjectId,
      attachmentPath.replaceAll("\\", "/"),
      { download: false, highlight: false, raw: true },
    );
    expect(await response.text()).toBe("png-bytes");
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
      capture: await captureSession(
        service,
        makeSession({ projectId: publicProjectId }),
      ),
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
      {
        ...(await captureSession(service)),
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
            makeAssistantMessage("new.md", {
              uuid: "00000000-0000-4000-8000-000000000002",
              timestamp: "2026-05-01T00:01:00.000Z",
            }),
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
      loadCompleteSession: vi.fn(async () => makeSession()),
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
      loadCompleteSession: vi.fn(async () => makeSession()),
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
      loadCompleteSession: vi.fn(async () =>
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

  it("skips complete capture for invalid or disconnected viewer freezes", async () => {
    await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-1" },
    });
    await service.disconnectSessionViewerToken(
      projectId,
      "session-1",
      "viewer-disconnected",
    );
    const loadCompleteSession = vi.fn(async () => makeSession());
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => makeSession()),
      loadCompleteSession,
      getPublicSharesEnabled: () => true,
    });

    for (const viewerId of ["short", "viewer-disconnected"]) {
      const response = await app.request(
        `/sessions/${projectId}/session-1/viewers/${viewerId}/freeze`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        viewerId,
        convertedCount: 0,
        liveCount: 1,
      });
    }
    expect(loadCompleteSession).not.toHaveBeenCalled();
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

  it("freezes only the exact confirmed live grants", async () => {
    const first = await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-1" },
    });
    const unselected = await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-1" },
    });
    const secondSession = await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-2" },
    });
    const alreadyFrozen = await service.createShare({
      mode: "frozen",
      source: { projectId, sessionId: "session-1" },
      capture: await captureSession(service),
    });
    const loadCompleteSession = vi.fn(
      async (loadedProjectId: UrlProjectId, sessionId: string) =>
        makeSession({ id: sessionId, projectId: loadedProjectId }),
    );
    const app = createPublicShareManagementFreezeRoutes({
      publicShareService: service,
      loadCompleteSession,
    });

    const response = await app.request("/public-shares/freeze-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION,
        shareIds: [
          first.record.shareId,
          first.record.shareId,
          secondSession.record.shareId,
          alreadyFrozen.record.shareId,
        ],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ convertedCount: 2 });
    expect(loadCompleteSession).toHaveBeenCalledTimes(4);
    expect(
      service
        .getAllRecords()
        .find((record) => record.shareId === first.record.shareId)?.mode,
    ).toBe("frozen");
    expect(
      service
        .getAllRecords()
        .find((record) => record.shareId === secondSession.record.shareId)
        ?.mode,
    ).toBe("frozen");
    expect(
      service
        .getAllRecords()
        .find((record) => record.shareId === unselected.record.shareId)?.mode,
    ).toBe("live");
  });

  it("does not capture or change an already-frozen grant", async () => {
    const alreadyFrozen = await service.createShare({
      mode: "frozen",
      source: { projectId, sessionId: "session-1" },
      capture: await captureSession(service),
    });
    const loadCompleteSession = vi.fn(async () => makeSession());
    const app = createPublicShareManagementFreezeRoutes({
      publicShareService: service,
      loadCompleteSession,
    });

    const response = await app.request("/public-shares/freeze-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION,
        shareIds: [alreadyFrozen.record.shareId],
      }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ convertedCount: 0 });
    expect(loadCompleteSession).not.toHaveBeenCalled();
    expect(service.getAllRecords()[0]?.mode).toBe("frozen");
  });

  it("requires explicit confirmation before selective freezing", async () => {
    const live = await service.createShare({
      mode: "live",
      source: { projectId, sessionId: "session-1" },
    });
    const loadCompleteSession = vi.fn(async () => makeSession());
    const app = createPublicShareManagementFreezeRoutes({
      publicShareService: service,
      loadCompleteSession,
    });

    const response = await app.request("/public-shares/freeze-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: "no",
        shareIds: [live.record.shareId],
      }),
    });

    expect(response.status).toBe(400);
    expect(loadCompleteSession).not.toHaveBeenCalled();
    expect(service.getAllRecords()[0]?.mode).toBe("live");
  });

  it("bounds selective-freeze bodies and reviewed grant counts", async () => {
    const loadCompleteSession = vi.fn(async () => makeSession());
    const app = createPublicShareManagementFreezeRoutes({
      publicShareService: service,
      loadCompleteSession,
    });

    const tooMany = await app.request("/public-shares/freeze-live", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        confirmation: PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION,
        shareIds: Array.from(
          { length: 101 },
          (_, index) => `share-id-${String(index).padStart(7, "0")}`,
        ),
      }),
    });
    const chunkedOverflow = await app.fetch(
      streamedJsonRequest("http://localhost/public-shares/freeze-live", {
        confirmation: PUBLIC_SHARE_MANAGEMENT_FREEZE_CONFIRMATION,
        shareIds: ["share-id-0000000"],
        padding: "x".repeat(33 * 1_024),
      }),
    );

    expect(tooMany.status).toBe(400);
    await expect(tooMany.json()).resolves.toMatchObject({
      error: "shareIds must contain 1 to 100 valid share IDs",
    });
    expect(chunkedOverflow.status).toBe(413);
    expect(loadCompleteSession).not.toHaveBeenCalled();
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
    expect(
      new Set(secondPage.items.map((item: { title: string }) => item.title)),
    ).toEqual(
      new Set(
        ["first", "second", "third"].filter(
          (title) => title !== firstPage.items[0].title,
        ),
      ),
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

  it("rejects malformed optional share text before loading or persisting", async () => {
    const loadSession = vi.fn(async () => makeSession());
    const loadCompleteSession = vi.fn(async () => makeSession());
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession,
      loadCompleteSession,
      getRelayConfig: () => ({
        url: DEFAULT_RELAY_URL,
        username: "host-one",
      }),
      getPublicSharesEnabled: () => true,
      getRemoteAccessEnabled: () => true,
      getRelayStatus: () => "waiting",
    });

    for (const [field, value] of [
      ["title", { poisoned: true }],
      ["initialPrompt", ["poisoned"]],
    ] as const) {
      const response = await app.request("/", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          sessionId: "session-1",
          mode: "live",
          [field]: value,
        }),
      });

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: `${field} must be a string`,
      });
    }

    expect(loadSession).not.toHaveBeenCalled();
    expect(loadCompleteSession).not.toHaveBeenCalled();
    expect(service.getValidShareCount()).toBe(0);
    const restarted = new PublicShareService({ dataDir: testDir });
    await expect(restarted.initialize()).resolves.toBeUndefined();
    expect(restarted.getReadiness()).toEqual({ state: "ready", error: null });
    expect(restarted.getValidShareCount()).toBe(0);
  });

  it("uses normalized user-turn provenance for context-shaped share prompts", async () => {
    const literalPrompt =
      "<environment_context>\nI typed this myself\n</environment_context>";
    const session = makeSession({
      messages: [
        makeUserMessage(literalPrompt, { codexUserTurnProvenance: "paired" }),
      ],
    });
    const app = createPublicShareRoutes({
      publicShareService: service,
      loadSession: vi.fn(async () => session),
      loadCompleteSession: vi.fn(async () => session),
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
      loadCompleteSession: vi.fn(async () => makeSession()),
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
      loadCompleteSession: vi.fn(async () => makeSession()),
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
      loadCompleteSession: vi.fn(async () => makeSession()),
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
      loadCompleteSession: vi.fn(async () => makeSession()),
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
      loadCompleteSession: vi.fn(async () => makeSession()),
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
      capture: await captureSession(service),
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
