import {
  createHash,
  generateKeyPairSync,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SECURITY_CLIENT_DESCRIPTOR_VERSION,
  SECURITY_CLIENT_KEY_PROTOCOL,
  SECURITY_CLIENT_REGISTER_ROUTE,
  buildSecurityClientProofTranscript,
  canonicalizeSecurityClientProofBody,
  securityClientCheckInProofBody,
  securityClientCheckInRoute,
  securityClientRegisterProofBody,
  type CheckInSecurityClientRequest,
  type RegisterSecurityClientRequest,
} from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticatedSrpTransportContext } from "../../src/middleware/authenticated-transport.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";
import { PushService } from "../../src/push/PushService.js";
import { BrowserProfileService } from "../../src/services/BrowserProfileService.js";
import { ConnectedBrowsersService } from "../../src/services/ConnectedBrowsersService.js";
import {
  SecurityClientService,
  SecurityClientServiceError,
} from "../../src/services/SecurityClientService.js";
import { EventBus } from "../../src/watcher/EventBus.js";

interface TestKey {
  privateKey: KeyObject;
  publicKeySpki: string;
}

function createTestKey(): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
  });
  return {
    privateKey,
    publicKeySpki: publicKey
      .export({ format: "der", type: "spki" })
      .toString("base64url"),
  };
}

function androidDescriptor(installationId = randomUUID()) {
  return {
    installationId,
    deviceClass: "phone" as const,
    deviceName: "Test Pixel",
    appName: "Yep Anywhere",
    appVersion: "0.0.1-dev",
    appBuild: 1,
    buildChannel: "debug",
    locale: "en-US",
    languages: ["en-US"],
    timeZone: "Europe/Berlin",
    supportedProofs: ["continuity-key" as const],
    manufacturer: "Google",
    brand: "google",
    model: "Pixel 8",
    product: "shiba",
    osName: "Android" as const,
    osVersion: "16",
    osApiLevel: 36,
    osBuildFingerprint: "google/shiba/test:userdebug/dev-keys",
    securityPatch: "2026-07-05",
    packageName: "com.yepanywhere.android",
    installerSource: "adb",
  };
}

function digestBody(body: unknown): Buffer {
  return createHash("sha256")
    .update(canonicalizeSecurityClientProofBody(body))
    .digest();
}

function signTranscript(
  key: TestKey,
  params: {
    operation: "register" | "check-in";
    route: string;
    sessionId: string;
    transportNonce: string;
    subjectId: string;
    body: unknown;
  },
): string {
  return sign(
    "sha256",
    buildSecurityClientProofTranscript({
      operation: params.operation,
      route: params.route,
      sessionId: params.sessionId,
      transportNonce: params.transportNonce,
      subjectId: params.subjectId,
      bodyDigest: digestBody(params.body),
    }),
    { key: key.privateKey, dsaEncoding: "der" },
  ).toString("base64url");
}

function registration(
  key: TestKey,
  transport: AuthenticatedSrpTransportContext,
  options: {
    requestId?: string;
    installationId?: string;
    label?: string;
  } = {},
): RegisterSecurityClientRequest {
  const request: RegisterSecurityClientRequest = {
    requestId: options.requestId ?? randomUUID(),
    kind: "android-native",
    label: options.label ?? "Kyle's Pixel",
    descriptorVersion: SECURITY_CLIENT_DESCRIPTOR_VERSION,
    descriptor: androidDescriptor(options.installationId),
    key: {
      protocol: SECURITY_CLIENT_KEY_PROTOCOL,
      publicKeySpki: key.publicKeySpki,
      reportedStorage: "android-keystore",
      signature: "pending",
    },
  };
  request.key.signature = signTranscript(key, {
    operation: "register",
    route: SECURITY_CLIENT_REGISTER_ROUTE,
    sessionId: transport.sessionId,
    transportNonce: transport.transportNonce,
    subjectId: request.requestId,
    body: securityClientRegisterProofBody(request),
  });
  return request;
}

function checkIn(
  key: TestKey,
  clientId: string,
  transport: AuthenticatedSrpTransportContext,
  installationId: string,
): CheckInSecurityClientRequest {
  const request: CheckInSecurityClientRequest = {
    descriptorVersion: SECURITY_CLIENT_DESCRIPTOR_VERSION,
    descriptor: androidDescriptor(installationId),
    signature: "pending",
  };
  request.signature = signTranscript(key, {
    operation: "check-in",
    route: securityClientCheckInRoute(clientId),
    sessionId: transport.sessionId,
    transportNonce: transport.transportNonce,
    subjectId: clientId,
    body: securityClientCheckInProofBody(request),
  });
  return request;
}

describe("SecurityClientService", () => {
  let testDir: string;
  let remoteSessions: RemoteSessionService;
  let service: SecurityClientService;
  const closedConnections: string[] = [];

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "security-client-test-"));
    remoteSessions = new RemoteSessionService({ dataDir: testDir });
    await remoteSessions.initialize();
    service = new SecurityClientService({
      dataDir: testDir,
      remoteSessionService: remoteSessions,
    });
    await service.initialize();
  });

  afterEach(async () => {
    await service.shutdown();
    remoteSessions.shutdown();
    closedConnections.length = 0;
    await fs.rm(testDir, { recursive: true, force: true });
  });

  async function transport(
    authenticationMethod: "srp-full" | "srp-resume" = "srp-full",
  ): Promise<AuthenticatedSrpTransportContext> {
    const sessionId = await remoteSessions.createSession(
      "testuser",
      new Uint8Array(32).fill(0x42),
    );
    const connectionId = randomUUID();
    return {
      kind: "srp",
      username: "testuser",
      sessionId,
      transportNonce: randomUUID(),
      authenticationMethod,
      transport: "direct",
      connectionId,
      peerAddress: "127.0.0.1",
      closeConnection: () => closedConnections.push(connectionId),
      closeAfterResponse: () => {},
      deferAfterResponse: () => {},
    };
  }

  it("registers a signed client without exposing its public key", async () => {
    const key = createTestKey();
    const connection = await transport();
    const request = registration(key, connection);

    const result = await service.register(request, connection);

    expect(result.created).toBe(true);
    expect(result.client.reportedLabel).toBe("Kyle's Pixel");
    expect(result.client.proofs[0]?.keyFingerprint).toMatch(
      /^[A-Za-z0-9_-]{43}$/,
    );
    expect(result.client.proofs[0]).not.toHaveProperty("publicKeySpki");
    expect(
      remoteSessions.getSession(connection.sessionId)?.securityClientId,
    ).toBe(result.client.clientId);
    expect(service.securityEvents()[0]).toMatchObject({
      type: "client-registered",
      clientId: result.client.clientId,
    });

    const statePath = path.join(testDir, "security-clients.json");
    const stat = await fs.stat(statePath);
    if (process.platform !== "win32") {
      expect(stat.mode & 0o777).toBe(0o600);
    }
  });

  it("makes request-id retries idempotent only for the same key and body", async () => {
    const key = createTestKey();
    const firstConnection = await transport();
    const requestId = randomUUID();
    const installationId = randomUUID();
    const firstRequest = registration(key, firstConnection, {
      requestId,
      installationId,
    });
    const first = await service.register(firstRequest, firstConnection);

    const retryConnection = await transport("srp-resume");
    const retryRequest = registration(key, retryConnection, {
      requestId,
      installationId,
    });
    const retry = await service.register(retryRequest, retryConnection);
    expect(retry.created).toBe(false);
    expect(retry.client.clientId).toBe(first.client.clientId);
    expect(
      service
        .securityEvents()
        .filter((event) => event.type === "client-registered"),
    ).toHaveLength(1);

    const attackerConnection = await transport();
    const conflicting = registration(createTestKey(), attackerConnection, {
      requestId,
      installationId,
    });
    await expect(
      service.register(conflicting, attackerConnection),
    ).rejects.toMatchObject({
      code: "security_client_request_conflict",
      status: 409,
    });
    expect(service.securityEvents()[0]).toMatchObject({
      type: "continuity-proof-failed",
      clientId: first.client.clientId,
    });
  });

  it("records failed continuity proofs without changing the descriptor", async () => {
    const key = createTestKey();
    const installationId = randomUUID();
    const registrationConnection = await transport();
    const registered = await service.register(
      registration(key, registrationConnection, { installationId }),
      registrationConnection,
    );
    service.disconnect(registrationConnection.connectionId);

    const resumeConnection = await transport("srp-resume");
    const forged = checkIn(
      createTestKey(),
      registered.client.clientId,
      resumeConnection,
      installationId,
    );
    await expect(
      service.checkIn(registered.client.clientId, forged, resumeConnection),
    ).rejects.toMatchObject({ code: "security_client_proof_invalid" });

    expect(service.get(registered.client.clientId).lastSeenAt).toBe(
      registered.client.lastSeenAt,
    );
    expect(service.events(registered.client.clientId)[0]).toMatchObject({
      type: "continuity-proof-failed",
      authenticationMethod: "srp-resume",
    });
    expect(service.securityEvents()[0]).toMatchObject({
      type: "continuity-proof-failed",
      clientId: registered.client.clientId,
    });
  });

  it("accepts one signed check-in and tolerates its exact repeat", async () => {
    const key = createTestKey();
    const installationId = randomUUID();
    const registrationConnection = await transport();
    const registered = await service.register(
      registration(key, registrationConnection, { installationId }),
      registrationConnection,
    );
    service.disconnect(registrationConnection.connectionId);

    const resumeConnection = await transport("srp-resume");
    const request = checkIn(
      key,
      registered.client.clientId,
      resumeConnection,
      installationId,
    );
    const first = await service.checkIn(
      registered.client.clientId,
      request,
      resumeConnection,
    );
    const repeat = await service.checkIn(
      registered.client.clientId,
      request,
      resumeConnection,
    );

    expect(repeat).toEqual(first);
    expect(
      service
        .events(registered.client.clientId)
        .filter((event) => event.type === "checked-in"),
    ).toHaveLength(1);
  });

  it("rejects descriptor mutation, wrong-route proof, and nonce replay", async () => {
    const key = createTestKey();
    const installationId = randomUUID();
    const registrationConnection = await transport();
    const registered = await service.register(
      registration(key, registrationConnection, { installationId }),
      registrationConnection,
    );
    service.disconnect(registrationConnection.connectionId);

    const signedConnection = await transport("srp-resume");
    const signed = checkIn(
      key,
      registered.client.clientId,
      signedConnection,
      installationId,
    );
    const mutated = structuredClone(signed);
    mutated.descriptor.deviceName = "Transplanted descriptor";
    await expect(
      service.checkIn(registered.client.clientId, mutated, signedConnection),
    ).rejects.toMatchObject({ code: "security_client_proof_invalid" });

    const wrongRoute = checkIn(
      key,
      registered.client.clientId,
      signedConnection,
      installationId,
    );
    wrongRoute.signature = signTranscript(key, {
      operation: "check-in",
      route: SECURITY_CLIENT_REGISTER_ROUTE,
      sessionId: signedConnection.sessionId,
      transportNonce: signedConnection.transportNonce,
      subjectId: registered.client.clientId,
      body: securityClientCheckInProofBody(wrongRoute),
    });
    await expect(
      service.checkIn(registered.client.clientId, wrongRoute, signedConnection),
    ).rejects.toMatchObject({ code: "security_client_proof_invalid" });

    const replayConnection = await transport("srp-resume");
    await expect(
      service.checkIn(registered.client.clientId, signed, replayConnection),
    ).rejects.toMatchObject({ code: "security_client_proof_invalid" });
    expect(service.events(registered.client.clientId)[0]).toMatchObject({
      type: "continuity-proof-failed",
      count: 3,
    });
  });

  it("tombstones before cascading session and socket revocation", async () => {
    const key = createTestKey();
    const connection = await transport();
    const registered = await service.register(
      registration(key, connection),
      connection,
    );

    const prepared = await service.prepareRevocation(
      registered.client.clientId,
    );
    expect(prepared.client.revokedAt).toBeTruthy();
    expect(remoteSessions.getSession(connection.sessionId)).not.toBeNull();
    expect(service.securityEvents()[0]).toMatchObject({
      type: "client-revoked",
      clientSnapshot: {
        keyFingerprint: registered.client.proofs[0]?.keyFingerprint,
      },
    });

    await prepared.cascade();
    expect(remoteSessions.getSession(connection.sessionId)).toBeNull();
    expect(closedConnections).toContain(connection.connectionId);

    const newConnection = await transport("srp-resume");
    await expect(
      service.checkIn(
        registered.client.clientId,
        checkIn(
          key,
          registered.client.clientId,
          newConnection,
          registered.client.descriptor.installationId,
        ),
        newConnection,
      ),
    ).rejects.toMatchObject({
      code: "security_client_revoked",
      status: 410,
    });
    expect(() => service.get(randomUUID())).toThrowError(
      expect.objectContaining({
        code: "security_client_unknown",
        status: 404,
      }),
    );
  });

  it("preserves global registration and revocation history across restart", async () => {
    const key = createTestKey();
    const connection = await transport();
    const registered = await service.register(
      registration(key, connection),
      connection,
    );
    await service.prepareRevocation(registered.client.clientId);
    await service.shutdown();
    remoteSessions.shutdown();
    const statePath = path.join(testDir, "security-clients.json");
    const validState = await fs.readFile(statePath, "utf8");
    await fs.writeFile(statePath, "{truncated");

    remoteSessions = new RemoteSessionService({ dataDir: testDir });
    await remoteSessions.initialize();
    service = new SecurityClientService({
      dataDir: testDir,
      remoteSessionService: remoteSessions,
    });
    await expect(service.initialize()).rejects.toThrow(
      "Failed to load security-client state",
    );
    await expect(fs.readFile(statePath, "utf8")).resolves.toBe("{truncated");

    await fs.writeFile(statePath, validState);
    await service.initialize();

    expect(service.get(registered.client.clientId).revokedAt).toBeTruthy();
    expect(service.securityEvents().map((event) => event.type)).toEqual([
      "client-revoked",
      "client-registered",
    ]);
  });

  it("coalesces repeated failed SRP attempts", async () => {
    await service.recordSrpFullFailed({
      username: "testuser",
      transport: "direct",
      peerAddress: "192.0.2.5",
    });
    await service.recordSrpFullFailed({
      username: "testuser",
      transport: "direct",
      peerAddress: "192.0.2.5",
    });

    expect(service.securityEvents()).toEqual([
      expect.objectContaining({
        type: "srp-full-failed",
        count: 2,
        firstOccurredAt: expect.any(String),
      }),
    ]);
  });

  it("projects and revokes legacy browser state without invented proof", async () => {
    await service.shutdown();
    const browserProfiles = new BrowserProfileService({ dataDir: testDir });
    const push = new PushService({ dataDir: testDir });
    const connected = new ConnectedBrowsersService(new EventBus());
    await browserProfiles.initialize();
    await push.initialize();
    await browserProfiles.recordConnection("legacy-profile", {
      origin: "https://localhost:3400",
      scheme: "https",
      hostname: "localhost",
      port: 3400,
      userAgent: "Mozilla/5.0 Legacy Test",
    });
    await push.subscribe(
      "legacy-profile",
      {
        endpoint: "https://push.example.test/subscription",
        keys: { p256dh: "p256dh", auth: "auth" },
      },
      { deviceName: "Kyle's Browser", userAgent: "Mozilla/5.0 Push Test" },
    );
    const sessionId = await remoteSessions.createSession(
      "testuser",
      new Uint8Array(32).fill(0x42),
      {
        browserProfileId: "legacy-profile",
        origin: "https://localhost:3400",
        userAgent: "Mozilla/5.0 Session Test",
      },
    );
    const closeLegacyTab = vi.fn();
    const tabId = connected.connect("legacy-profile", "ws", closeLegacyTab);
    service = new SecurityClientService({
      dataDir: testDir,
      remoteSessionService: remoteSessions,
      browserProfileService: browserProfiles,
      connectedBrowsers: connected,
      pushService: push,
    });
    await service.initialize();

    const legacy = service
      .list()
      .find((client) => client.kind === "legacy-web");
    expect(legacy).toMatchObject({
      reportedLabel: "Kyle's Browser",
      assurance: "authenticated-session",
      proofs: [],
      activeConnectionCount: 1,
      push: { enabled: true },
      legacyBrowserProfileId: "legacy-profile",
      descriptor: {
        installationId: "legacy-profile",
        origin: "https://localhost:3400",
        userAgent: "Mozilla/5.0 Legacy Test",
      },
    });
    expect(legacy?.sessions).toHaveLength(1);

    const labeled = await service.patch(legacy!.clientId, {
      ownerLabel: "My daily browser",
    });
    expect(labeled.client).toMatchObject({
      ownerLabel: "My daily browser",
      displayLabel: "My daily browser",
      reportedLabel: "Kyle's Browser",
    });

    const prepared = await service.prepareRevocation(legacy!.clientId);
    await prepared.cascade();
    expect(browserProfiles.getProfile("legacy-profile")).toBeNull();
    expect(push.isSubscribed("legacy-profile")).toBe(false);
    expect(remoteSessions.getSession(sessionId)).toBeNull();
    expect(service.list()).not.toContainEqual(
      expect.objectContaining({ legacyBrowserProfileId: "legacy-profile" }),
    );
    expect(closeLegacyTab).toHaveBeenCalledOnce();
    expect(service.securityEvents()[0]).toMatchObject({
      type: "client-revoked",
      clientSnapshot: { kind: "legacy-web" },
    });
    connected.disconnect(tabId);
  });

  it("fails closed on malformed persisted descriptors", async () => {
    await service.shutdown();
    const statePath = path.join(testDir, "security-clients.json");
    const malformedState = JSON.stringify({
      version: 1,
      clients: {
        bad: {
          clientId: "bad",
          username: "testuser",
          kind: "android-native",
          reportedLabel: "Bad",
          descriptorVersion: 1,
          descriptor: { appName: "not enough" },
          descriptorDigest: "bad",
          proofs: [
            {
              type: "continuity-key",
              publicKeySpki: "bad",
              keyFingerprint: "bad",
            },
          ],
          createdAt: new Date().toISOString(),
          lastSeenAt: new Date().toISOString(),
          descriptorUpdatedAt: new Date().toISOString(),
          events: [],
        },
      },
      registrationRequests: {},
      securityEvents: [],
    });
    await fs.writeFile(statePath, malformedState);

    service = new SecurityClientService({
      dataDir: testDir,
      remoteSessionService: remoteSessions,
    });
    await expect(service.initialize()).rejects.toThrow(
      "Failed to load security-client state",
    );
    await expect(fs.readFile(statePath, "utf8")).resolves.toBe(malformedState);
    expect(() => service.list()).toThrow("not initialized");
  });

  it("fails closed on state from a newer server version", async () => {
    await service.shutdown();
    const statePath = path.join(testDir, "security-clients.json");
    const futureState = JSON.stringify({
      version: 2,
      clients: {},
      registrationRequests: {},
      legacyOwnerLabels: {},
      revokedLegacyBrowserProfiles: {},
      securityEvents: [],
    });
    await fs.writeFile(statePath, futureState);

    service = new SecurityClientService({
      dataDir: testDir,
      remoteSessionService: remoteSessions,
    });
    await expect(service.initialize()).rejects.toThrow(
      "Failed to load security-client state",
    );
    await expect(fs.readFile(statePath, "utf8")).resolves.toBe(futureState);
    expect(() => service.list()).toThrow("not initialized");
  });

  it("uses typed service errors for unknown clients", () => {
    expect(() => service.get("missing")).toThrow(SecurityClientServiceError);
  });
});
