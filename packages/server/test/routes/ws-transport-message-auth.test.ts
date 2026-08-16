import { MIN_BINARY_ENVELOPE_LENGTH } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deriveTransportKey, encrypt } from "../../src/crypto/index.js";
import { getLogger } from "../../src/logging/logger.js";
import { createConnectionState } from "../../src/routes/ws-relay-handlers.js";
import {
  isBinaryEncryptedEnvelope,
  parseApplicationClientMessage,
  rejectPlaintextBinaryWhenEncryptedRequired,
} from "../../src/routes/ws-transport-message-auth.js";

function createMockWs() {
  return {
    close: vi.fn<(code?: number, reason?: string) => void>(),
    send: vi.fn(),
  };
}

const publicShareSecret = "A".repeat(22);

function captureWarning() {
  return vi.spyOn(getLogger(), "warn").mockImplementation(() => undefined);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WebSocket Transport Message Auth Helpers", () => {
  it("does not treat pre-auth bytes as encrypted envelope", () => {
    const connState = createConnectionState();
    const bytes = new Uint8Array(25);
    bytes[0] = 0x01;

    expect(isBinaryEncryptedEnvelope(bytes, connState)).toBe(false);
  });

  it("treats authenticated SRP transport bytes with envelope prefix as encrypted", () => {
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32);
    const bytes = new Uint8Array(MIN_BINARY_ENVELOPE_LENGTH);
    bytes[0] = 0x01;

    expect(isBinaryEncryptedEnvelope(bytes, connState)).toBe(true);
  });

  it("rejects plaintext binary when encrypted messages are required", () => {
    const warn = captureWarning();
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32);
    connState.requiresEncryptedMessages = true;
    const ws = createMockWs();

    const rejected = rejectPlaintextBinaryWhenEncryptedRequired(
      ws,
      connState,
      true,
    );

    expect(rejected).toBe(true);
    expect(ws.close).toHaveBeenCalledWith(4005, "Encrypted message required");
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received plaintext binary frame after authentication",
    );
  });

  it("rejects plaintext application message when SRP policy requires auth", () => {
    const warn = captureWarning();
    const connState = createConnectionState();
    const ws = createMockWs();
    const parsed = { type: "ping", id: "p1" };

    const msg = parseApplicationClientMessage(ws, connState, true, parsed);

    expect(msg).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(4001, "Authentication required");
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received plaintext message but auth required",
    );
  });

  it("rejects pre-auth public-share attempts to reach speech credit routes", () => {
    const warn = captureWarning();
    const connState = createConnectionState();
    const ws = createMockWs();
    const parsed = {
      type: "request",
      id: "speech-secret",
      method: "GET",
      path: "/api/speech/xai-client-secret",
    };

    const msg = parseApplicationClientMessage(ws, connState, true, parsed);

    expect(msg).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(4001, "Authentication required");
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received plaintext message but auth required",
    );
  });

  it.each([
    `/public-api/shares/${publicShareSecret}?wire=raw-json`,
    `/public-api/shares/${publicShareSecret}/metadata?viewerId=viewer-1234`,
    `/public-api/shares/${publicShareSecret}/session-chunks?viewerId=viewer-1234&cursor=opaque-next`,
    `/public-api/shares/${publicShareSecret}/files/raw?path=note.md`,
  ])("accepts one canonical pre-auth public-share GET target: %s", (path) => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const parsed = {
      type: "request",
      id: "public-share-read",
      method: "GET",
      path,
    } as const;

    const msg = parseApplicationClientMessage(ws, connState, true, parsed);

    expect(msg).toEqual(parsed);
    expect(connState.connectionMode).toBe("public_read_only");
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("accepts sequential public reads after public mode is selected", () => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const parsed = {
      type: "request",
      id: "public-share-read",
      method: "GET",
      path: `/public-api/shares/${publicShareSecret}/metadata`,
    } as const;

    expect(parseApplicationClientMessage(ws, connState, true, parsed)).toEqual(
      parsed,
    );
    expect(
      parseApplicationClientMessage(ws, connState, true, {
        ...parsed,
        id: "public-share-read-2",
      }),
    ).toMatchObject({ id: "public-share-read-2" });
    expect(connState.connectionMode).toBe("public_read_only");
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("rejects a public read after SRP mode is selected", () => {
    const warn = captureWarning();
    const connState = createConnectionState();
    connState.connectionMode = "srp";
    const ws = createMockWs();

    expect(
      parseApplicationClientMessage(ws, connState, true, {
        type: "request",
        id: "public-after-srp",
        method: "GET",
        path: `/public-api/shares/${publicShareSecret}/metadata`,
      }),
    ).toBeNull();
    expect(connState.connectionMode).toBe("srp");
    expect(ws.close).toHaveBeenCalledWith(4001, "Authentication required");
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received plaintext message but auth required",
    );
  });

  it.each([
    [
      "dot segments",
      `/public-api/shares/${publicShareSecret}/../../../api/settings`,
    ],
    [
      "encoded dot segments",
      `/public-api/shares/${publicShareSecret}/%2e%2e/%2e%2e/api/settings`,
    ],
    [
      "backslashes",
      `/public-api/shares/${publicShareSecret}\\..\\..\\api\\settings`,
    ],
    [
      "authority target",
      `//relay.invalid/public-api/shares/${publicShareSecret}`,
    ],
    [
      "encoded path separator",
      `/public-api/shares/${publicShareSecret}%2Fmetadata`,
    ],
    ["fragment", `/public-api/shares/${publicShareSecret}#metadata`],
    ["reserved authenticated route", "/api/settings"],
  ])("rejects ambiguous pre-auth request target with %s", (_label, path) => {
    const warn = captureWarning();
    const connState = createConnectionState();
    const ws = createMockWs();

    const msg = parseApplicationClientMessage(ws, connState, true, {
      type: "request",
      id: "ambiguous-public-share",
      method: "GET",
      path,
    });

    expect(msg).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(4001, "Authentication required");
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received plaintext message but auth required",
    );
  });

  it("accepts plaintext application message when SRP is not required", () => {
    const connState = createConnectionState();
    const ws = createMockWs();
    const parsed = { type: "ping", id: "p2" };

    const msg = parseApplicationClientMessage(ws, connState, false, parsed);

    expect(msg).toEqual(parsed);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("rejects obsolete encrypted JSON envelope when SRP transport is established", () => {
    const warn = captureWarning();
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.sessionKey = new Uint8Array(32).fill(7);
    connState.requiresEncryptedMessages = true;
    const ws = createMockWs();
    const plaintext = JSON.stringify({
      seq: 0,
      msg: { type: "ping", id: "p3" },
    });
    const { nonce, ciphertext } = encrypt(plaintext, connState.sessionKey);
    const envelope = { type: "encrypted", nonce, ciphertext };

    const msg = parseApplicationClientMessage(ws, connState, true, envelope);

    expect(msg).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(
      4005,
      "Binary encrypted message required",
    );
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received obsolete encrypted text envelope",
    );
  });

  it("rejects pre-auth encrypted JSON envelope", () => {
    const warn = captureWarning();
    const connState = createConnectionState();
    const ws = createMockWs();
    const envelope = encrypt(
      JSON.stringify({ seq: 0, msg: { type: "ping", id: "p4" } }),
      new Uint8Array(32).fill(7),
    );

    expect(
      parseApplicationClientMessage(ws, connState, true, {
        type: "encrypted",
        nonce: envelope.nonce,
        ciphertext: envelope.ciphertext,
      }),
    ).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(4001, "Authentication required");
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received encrypted message but not authenticated",
    );
  });

  it("rejects obsolete base-key encrypted JSON envelope", () => {
    const warn = captureWarning();
    const connState = createConnectionState();
    connState.authState = "authenticated";
    connState.baseSessionKey = new Uint8Array(32).fill(9);
    connState.sessionKey = deriveTransportKey(
      connState.baseSessionKey,
      Buffer.from(new Uint8Array(24).fill(3)).toString("base64"),
    );
    connState.requiresEncryptedMessages = true;
    const ws = createMockWs();

    // Simulate an older client that still encrypts using the long-lived base key.
    const plaintext = JSON.stringify({
      type: "client_capabilities",
      formats: [1, 2, 3],
    });
    const envelope = encrypt(plaintext, connState.baseSessionKey);

    const msg = parseApplicationClientMessage(ws, connState, true, {
      type: "encrypted",
      nonce: envelope.nonce,
      ciphertext: envelope.ciphertext,
    });

    expect(msg).toBeNull();
    expect(ws.close).toHaveBeenCalledWith(
      4005,
      "Binary encrypted message required",
    );
    expect(warn).toHaveBeenCalledWith(
      "[WS Relay] Received obsolete encrypted text envelope",
    );
  });
});
