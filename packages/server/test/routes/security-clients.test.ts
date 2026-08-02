import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  SECURITY_CLIENT_KEY_PROTOCOL,
  SECURITY_CLIENT_REGISTER_ROUTE,
  buildSecurityClientProofTranscript,
  canonicalizeSecurityClientProofBody,
  securityClientRegisterProofBody,
  type RegisterSecurityClientRequest,
} from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTHENTICATED_SRP_TRANSPORT,
  type AuthenticatedSrpTransportContext,
} from "../../src/middleware/authenticated-transport.js";
import { RemoteSessionService } from "../../src/remote-access/RemoteSessionService.js";
import { createSecurityClientRoutes } from "../../src/routes/security-clients.js";
import { SecurityClientService } from "../../src/services/SecurityClientService.js";

describe("security-client routes", () => {
  let testDir: string;
  let remoteSessions: RemoteSessionService;
  let service: SecurityClientService;
  let app: Hono;
  let transport: AuthenticatedSrpTransportContext;
  let request: RegisterSecurityClientRequest;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "security-route-test-"));
    remoteSessions = new RemoteSessionService({ dataDir: testDir });
    await remoteSessions.initialize();
    service = new SecurityClientService({
      dataDir: testDir,
      remoteSessionService: remoteSessions,
    });
    await service.initialize();
    app = createSecurityClientRoutes(service);

    const sessionId = await remoteSessions.createSession(
      "testuser",
      new Uint8Array(32).fill(0x42),
    );
    transport = {
      kind: "srp",
      username: "testuser",
      sessionId,
      transportNonce: randomUUID(),
      authenticationMethod: "srp-full",
      transport: "direct",
      connectionId: randomUUID(),
      closeConnection: () => {},
      closeAfterResponse: () => {},
      deferAfterResponse: () => {},
    };
    const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
    });
    request = {
      requestId: randomUUID(),
      kind: "android-native",
      label: "Test Pixel",
      descriptorVersion: 1,
      descriptor: {
        installationId: randomUUID(),
        deviceClass: "phone",
        appName: "Yep Anywhere",
        appVersion: "dev",
        supportedProofs: ["continuity-key"],
        osName: "Android",
        osVersion: "16",
        osApiLevel: 36,
        packageName: "com.yepanywhere.android",
      },
      key: {
        protocol: SECURITY_CLIENT_KEY_PROTOCOL,
        publicKeySpki: publicKey
          .export({ format: "der", type: "spki" })
          .toString("base64url"),
        reportedStorage: "android-keystore",
        signature: "pending",
      },
    };
    const bodyDigest = createHash("sha256")
      .update(
        canonicalizeSecurityClientProofBody(
          securityClientRegisterProofBody(request),
        ),
      )
      .digest();
    request.key.signature = sign(
      "sha256",
      buildSecurityClientProofTranscript({
        operation: "register",
        route: SECURITY_CLIENT_REGISTER_ROUTE,
        sessionId,
        transportNonce: transport.transportNonce,
        subjectId: request.requestId,
        bodyDigest,
      }),
      { key: privateKey, dsaEncoding: "der" },
    ).toString("base64url");
  });

  afterEach(async () => {
    await service.shutdown();
    remoteSessions.shutdown();
    await fs.rm(testDir, { recursive: true, force: true });
  });

  function registrationRequest(): Request {
    return new Request(`http://localhost${SECURITY_CLIENT_REGISTER_ROUTE}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Ws-Relay": "authenticated",
        "X-Security-Client-Transport": "srp",
      },
      body: JSON.stringify(request),
    });
  }

  it("rejects valid proof requests when only forgeable headers are present", async () => {
    const response = await app.fetch(registrationRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      code: "security_client_transport_required",
    });
    expect(service.list()).toEqual([]);
  });

  it("accepts the same proof through private SRP transport context", async () => {
    const response = await app.fetch(registrationRequest(), {
      [AUTHENTICATED_SRP_TRANSPORT]: transport,
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      client: { reportedLabel: "Test Pixel" },
    });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
