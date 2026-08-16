// @vitest-environment node

import { encodeTransportChunkFrames } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureConnection } from "../SecureConnection";
import {
  decryptBinaryEnvelope,
  deriveSecretboxKey,
  encrypt,
  encryptToBinaryEnvelope,
  generateRandomKey,
} from "../nacl-wrapper";

afterEach(() => {
  vi.restoreAllMocks();
});

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function nonceBase64(fill: number): string {
  const bytes = new Uint8Array(24).fill(fill);
  return bytesBase64(bytes);
}

function resumeServerProof(params: {
  sessionId: string;
  serverNonce: string;
  clientNonce: string;
  resumeProtocolVersion?: number;
  key: Uint8Array;
}): string {
  return JSON.stringify(
    encrypt(
      JSON.stringify({
        type: "srp_resume_server_proof",
        sessionId: params.sessionId,
        serverNonce: params.serverNonce,
        clientNonce: params.clientNonce,
        resumeProtocolVersion: params.resumeProtocolVersion ?? 3,
      }),
      params.key,
    ),
  );
}

function srpVerifyServerInfoProof(params: {
  sessionId: string;
  transportNonce: string;
  resumeProtocolVersion?: number;
  key: Uint8Array;
}): string {
  return JSON.stringify(
    encrypt(
      JSON.stringify({
        type: "srp_verify_server_info",
        sessionId: params.sessionId,
        transportNonce: params.transportNonce,
        resumeProtocolVersion: params.resumeProtocolVersion ?? 3,
      }),
      params.key,
    ),
  );
}

describe("SecureConnection protocol compatibility", () => {
  it("reassembles transport chunks before decrypting a server message", async () => {
    const sessionKey = new Uint8Array(32).fill(9);
    const routeMessage = vi.fn();
    const close = vi.fn();
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      sessionKey: Uint8Array;
      ws: { close: ReturnType<typeof vi.fn> };
      protocol: { routeMessage: ReturnType<typeof vi.fn> };
      handleMessage: (data: ArrayBuffer) => Promise<void>;
    };
    conn.sessionKey = sessionKey;
    conn.ws = { close };
    conn.protocol = { routeMessage };

    const message = {
      type: "pong",
      id: "chunked-secure-pong",
      padding: "secure-transport-padding".repeat(30_000),
    };
    const envelope = encryptToBinaryEnvelope(
      JSON.stringify({ seq: 0, msg: message }),
      sessionKey,
    );
    const chunks = Array.from(encodeTransportChunkFrames(4, envelope));
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks.slice(0, -1)) {
      await conn.handleMessage(chunk);
      expect(routeMessage).not.toHaveBeenCalled();
    }
    await conn.handleMessage(chunks.at(-1) as ArrayBuffer);

    expect(routeMessage).toHaveBeenCalledOnce();
    expect(routeMessage).toHaveBeenCalledWith(message);
    expect(close).not.toHaveBeenCalled();
  });

  it("does not tear down an in-flight ensureConnected recovery", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      ws: {
        close: ReturnType<typeof vi.fn>;
        onclose: unknown;
        onerror: unknown;
        onmessage: unknown;
      } | null;
      connectionState: string;
      ensureConnected: () => Promise<void>;
      forceReconnect: () => Promise<void>;
      connectAndAuthenticate: ReturnType<typeof vi.fn>;
      protocol: {
        rejectAllPending: ReturnType<typeof vi.fn>;
        notifySubscriptionsClosed: ReturnType<typeof vi.fn>;
      };
    };

    let resolveConnect!: () => void;
    conn.connectAndAuthenticate = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveConnect = () => {
            conn.connectionState = "authenticated";
            resolve();
          };
        }),
    );
    const close = vi.fn();
    conn.ws = {
      close,
      onclose: vi.fn(),
      onerror: vi.fn(),
      onmessage: vi.fn(),
    };
    conn.protocol = {
      rejectAllPending: vi.fn(),
      notifySubscriptionsClosed: vi.fn(),
    };

    const recovery = conn.ensureConnected();
    await Promise.resolve();

    const forced = conn.forceReconnect();
    await Promise.resolve();

    expect(conn.connectAndAuthenticate).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
    expect(conn.protocol.rejectAllPending).not.toHaveBeenCalled();
    expect(conn.protocol.notifySubscriptionsClosed).not.toHaveBeenCalled();

    resolveConnect();

    await expect(recovery).resolves.toBeUndefined();
    await expect(forced).resolves.toBeUndefined();
    expect(conn.connectAndAuthenticate).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();
  });

  it("starts a fresh forced reconnect if in-flight recovery fails", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      ws: {
        close: ReturnType<typeof vi.fn>;
        onclose: unknown;
        onerror: unknown;
        onmessage: unknown;
      } | null;
      connectionState: string;
      ensureConnected: () => Promise<void>;
      forceReconnect: () => Promise<void>;
      connectAndAuthenticate: ReturnType<typeof vi.fn>;
      protocol: {
        rejectAllPending: ReturnType<typeof vi.fn>;
        notifySubscriptionsClosed: ReturnType<typeof vi.fn>;
      };
    };

    let rejectFirst!: (error: Error) => void;
    let resolveSecond!: () => void;
    conn.connectAndAuthenticate = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveSecond = () => {
              conn.connectionState = "authenticated";
              resolve();
            };
          }),
      );
    const close = vi.fn();
    conn.ws = {
      close,
      onclose: vi.fn(),
      onerror: vi.fn(),
      onmessage: vi.fn(),
    };
    conn.protocol = {
      rejectAllPending: vi.fn(),
      notifySubscriptionsClosed: vi.fn(),
    };

    const recovery = conn.ensureConnected();
    await Promise.resolve();

    const forced = conn.forceReconnect();
    await Promise.resolve();

    expect(conn.connectAndAuthenticate).toHaveBeenCalledTimes(1);
    expect(close).not.toHaveBeenCalled();

    const recoveryError = new Error("resume failed");
    rejectFirst(recoveryError);

    await expect(recovery).rejects.toBe(recoveryError);
    await vi.waitFor(() =>
      expect(conn.connectAndAuthenticate).toHaveBeenCalledTimes(2),
    );

    expect(conn.protocol.rejectAllPending).toHaveBeenCalledTimes(1);
    expect(conn.protocol.notifySubscriptionsClosed).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);

    resolveSecond();

    await expect(forced).resolves.toBeUndefined();
  });

  it("rejects full SRP when server omits the transport nonce", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const onAuthenticated = vi.fn();
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
      { onAuthenticated },
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      srpSession: {
        verifyServer: (m2: string) => Promise<boolean>;
        getSessionKey: () => Uint8Array;
      };
      connectionState: string;
      handleSrpVerify: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    const close = vi.fn();
    conn.ws = { readyState: 1, send, close };
    conn.srpSession = {
      verifyServer: vi.fn().mockResolvedValue(true),
      getSessionKey: vi.fn().mockReturnValue(generateRandomKey()),
    };

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpVerify(
      JSON.stringify({
        type: "srp_verify",
        M2: "abc123",
        sessionId: "sess-1",
      }),
      resolve,
      reject,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]?.message).toBe(
      "Server protocol verification failed",
    );
    expect(conn.connectionState).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalledWith(
      "[SecureConnection] SRP verify missing required protocol metadata",
    );
  });

  it("accepts protocol 2 full SRP during the grace period", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
      srpSession: {
        verifyServer: (m2: string) => Promise<boolean>;
        getSessionKey: () => Uint8Array;
      };
      sessionKey: Uint8Array;
      storedSession: {
        sessionId: string;
        resumeProtocolVersion?: number;
      } | null;
      handleSrpVerify: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send };
    const rawKey = generateRandomKey();
    const transportNonce = nonceBase64(3);
    conn.srpSession = {
      verifyServer: vi.fn().mockResolvedValue(true),
      getSessionKey: vi.fn().mockReturnValue(rawKey),
    };

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpVerify(
      JSON.stringify({
        type: "srp_verify",
        M2: "abc123",
        sessionId: "sess-v2",
        transportNonce,
      }),
      resolve,
      reject,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(conn.storedSession?.sessionId).toBe("sess-v2");
    expect(conn.storedSession?.resumeProtocolVersion).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);

    const sent = send.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(ArrayBuffer);
    const plaintext = decryptBinaryEnvelope(
      sent as ArrayBuffer,
      conn.sessionKey,
    );
    const parsed = JSON.parse(plaintext ?? "{}") as {
      seq: number;
      msg: { type: string };
    };
    expect(parsed.seq).toBe(0);
    expect(parsed.msg.type).toBe("client_capabilities");
  });

  it("uses sequenced binary encrypted envelopes on current servers", async () => {
    const onAuthenticated = vi.fn();
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
      { onAuthenticated },
    ) as unknown as {
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
      srpSession: {
        verifyServer: (m2: string) => Promise<boolean>;
        getSessionKey: () => Uint8Array;
      };
      sessionKey: Uint8Array;
      handleSrpVerify: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send };
    const rawKey = generateRandomKey();
    const baseSessionKey = deriveSecretboxKey(rawKey);
    const transportNonce = nonceBase64(9);
    conn.srpSession = {
      verifyServer: vi.fn().mockResolvedValue(true),
      getSessionKey: vi.fn().mockReturnValue(rawKey),
    };

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpVerify(
      JSON.stringify({
        type: "srp_verify",
        M2: "abc123",
        sessionId: "sess-1",
        transportNonce,
        serverInfoProof: srpVerifyServerInfoProof({
          sessionId: "sess-1",
          transportNonce,
          key: baseSessionKey,
        }),
      }),
      resolve,
      reject,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(onAuthenticated).toHaveBeenCalledTimes(1);

    const sent = send.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(ArrayBuffer);
    const plaintext = decryptBinaryEnvelope(
      sent as ArrayBuffer,
      conn.sessionKey,
    );
    expect(plaintext).not.toBeNull();
    const parsed = JSON.parse(plaintext ?? "{}") as {
      seq: number;
      msg: { type: string };
    };
    expect(parsed.seq).toBe(0);
    expect(parsed.msg.type).toBe("client_capabilities");
  });

  it("pins authenticated resume protocol after full SRP", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
      { onSessionEstablished: vi.fn() },
    ) as unknown as {
      ws: { readyState: number; send: ReturnType<typeof vi.fn> };
      srpSession: {
        verifyServer: (m2: string) => Promise<boolean>;
        getSessionKey: () => Uint8Array;
      };
      storedSession: {
        sessionId: string;
        resumeProtocolVersion?: number;
      } | null;
      handleSrpVerify: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send };
    const rawKey = generateRandomKey();
    const baseSessionKey = deriveSecretboxKey(rawKey);
    const sessionId = "sess-full-srp";
    const transportNonce = nonceBase64(11);
    conn.srpSession = {
      verifyServer: vi.fn().mockResolvedValue(true),
      getSessionKey: vi.fn().mockReturnValue(rawKey),
    };

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpVerify(
      JSON.stringify({
        type: "srp_verify",
        M2: "abc123",
        sessionId,
        transportNonce,
        serverInfoProof: srpVerifyServerInfoProof({
          sessionId,
          transportNonce,
          resumeProtocolVersion: 3,
          key: baseSessionKey,
        }),
      }),
      resolve,
      reject,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(conn.storedSession?.sessionId).toBe(sessionId);
    expect(conn.storedSession?.resumeProtocolVersion).toBe(3);
  });

  it("rejects protocol 2 full SRP when protocol 3 is already pinned", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      srpSession: {
        verifyServer: (m2: string) => Promise<boolean>;
        getSessionKey: () => Uint8Array;
      };
      connectionState: string;
      minimumResumeProtocolVersion: number | null;
      handleSrpVerify: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    const close = vi.fn();
    conn.ws = { readyState: 1, send, close };
    conn.minimumResumeProtocolVersion = 3;
    conn.srpSession = {
      verifyServer: vi.fn().mockResolvedValue(true),
      getSessionKey: vi.fn().mockReturnValue(generateRandomKey()),
    };

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpVerify(
      JSON.stringify({
        type: "srp_verify",
        M2: "abc123",
        sessionId: "sess-downgrade",
        transportNonce: nonceBase64(12),
      }),
      resolve,
      reject,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]?.message).toBe(
      "Server protocol verification failed",
    );
    expect(conn.connectionState).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "[SecureConnection] SRP verify would downgrade authenticated protocol",
    );
  });

  it("attempts grace-period resume for protocol 2 and unstamped sessions", () => {
    const protocol2Conn = SecureConnection.forResumeOnly({
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId: "sess-v2",
      sessionKey: bytesBase64(generateRandomKey()),
      resumeProtocolVersion: 2,
    }) as unknown as {
      storedSessionSupportsCurrentResume: () => boolean;
    };

    const unstampedConn = SecureConnection.forResumeOnly({
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId: "sess-unstamped",
      sessionKey: bytesBase64(generateRandomKey()),
    }) as unknown as {
      storedSessionSupportsCurrentResume: () => boolean;
    };

    const protocol1Conn = SecureConnection.forResumeOnly({
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId: "sess-v1",
      sessionKey: bytesBase64(generateRandomKey()),
      resumeProtocolVersion: 1,
    }) as unknown as {
      storedSessionSupportsCurrentResume: () => boolean;
    };

    expect(protocol2Conn.storedSessionSupportsCurrentResume()).toBe(true);
    expect(unstampedConn.storedSessionSupportsCurrentResume()).toBe(true);
    expect(protocol1Conn.storedSessionSupportsCurrentResume()).toBe(false);
  });

  it("rejects unsequenced encrypted responses", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
    ) as unknown as {
      ws: { close: ReturnType<typeof vi.fn> };
      sessionKey: Uint8Array;
      protocol: { routeMessage: ReturnType<typeof vi.fn> };
      handleMessage: (data: unknown) => Promise<void>;
    };

    conn.ws = { close: vi.fn() };
    const key = generateRandomKey();
    conn.sessionKey = key;
    conn.protocol = { routeMessage: vi.fn() };

    const msg = { type: "pong", id: "unsequenced-1" };
    const encrypted = encryptToBinaryEnvelope(JSON.stringify(msg), key);
    await conn.handleMessage(encrypted);

    expect(conn.protocol.routeMessage).not.toHaveBeenCalled();
    expect(conn.ws.close).toHaveBeenCalledWith(4004, "Invalid sequence");
    expect(warn).toHaveBeenCalledWith(
      "[SecureConnection] Missing/invalid encrypted sequence",
    );
  });

  it("accepts protocol 3 resume with encrypted server proof", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "",
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        onmessage?: unknown;
      };
      storedSession: {
        wsUrl: string;
        username: string;
        sessionId: string;
        sessionKey: string;
        resumeProtocolVersion?: number;
      };
      sessionKey: Uint8Array | null;
      pendingResumeClientNonce: string | null;
      pendingResumeServerNonce: string | null;
      handleSrpResumeResponse: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send, close: vi.fn() };
    const baseSessionKey = generateRandomKey();
    const sessionId = "sess-resume";
    const clientNonce = nonceBase64(5);
    const serverNonce = nonceBase64(6);
    conn.storedSession = {
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId,
      sessionKey: bytesBase64(baseSessionKey),
      resumeProtocolVersion: 3,
    };
    conn.pendingResumeClientNonce = clientNonce;
    conn.pendingResumeServerNonce = serverNonce;

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpResumeResponse(
      JSON.stringify({
        type: "srp_resumed",
        sessionId,
        transportNonce: serverNonce,
        serverProof: resumeServerProof({
          sessionId,
          serverNonce,
          clientNonce,
          key: baseSessionKey,
        }),
      }),
      resolve,
      reject,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(conn.sessionKey).not.toBeNull();

    const sent = send.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(ArrayBuffer);
    const plaintext = decryptBinaryEnvelope(
      sent as ArrayBuffer,
      conn.sessionKey!,
    );
    const parsed = JSON.parse(plaintext ?? "{}") as {
      seq: number;
      msg: { type: string };
    };
    expect(parsed.seq).toBe(0);
    expect(parsed.msg.type).toBe("client_capabilities");
    expect(conn.storedSession.resumeProtocolVersion).toBe(3);
  });

  it("accepts protocol 2 resume during grace when transport nonce is present", async () => {
    const onSessionEstablished = vi.fn();
    const onAuthenticated = vi.fn();
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "",
      { onSessionEstablished, onAuthenticated },
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        onmessage?: unknown;
      };
      storedSession: {
        wsUrl: string;
        username: string;
        sessionId: string;
        sessionKey: string;
        resumeProtocolVersion?: number;
      };
      sessionKey: Uint8Array | null;
      pendingResumeClientNonce: string | null;
      pendingResumeServerNonce: string | null;
      handleSrpResumeResponse: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send, close: vi.fn() };
    const baseSessionKey = generateRandomKey();
    const sessionId = "sess-v2-resume";
    const clientNonce = nonceBase64(13);
    const serverNonce = nonceBase64(14);
    conn.storedSession = {
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId,
      sessionKey: bytesBase64(baseSessionKey),
      resumeProtocolVersion: 2,
    };
    conn.pendingResumeClientNonce = clientNonce;
    conn.pendingResumeServerNonce = serverNonce;

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpResumeResponse(
      JSON.stringify({
        type: "srp_resumed",
        sessionId,
        transportNonce: serverNonce,
      }),
      resolve,
      reject,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledTimes(1);
    expect(conn.sessionKey).not.toBeNull();
    expect(conn.storedSession.resumeProtocolVersion).toBe(2);
    expect(onSessionEstablished).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, resumeProtocolVersion: 2 }),
    );
    expect(onAuthenticated).toHaveBeenCalledTimes(1);

    const sent = send.mock.calls[0]?.[0];
    expect(sent).toBeInstanceOf(ArrayBuffer);
    const plaintext = decryptBinaryEnvelope(
      sent as ArrayBuffer,
      conn.sessionKey!,
    );
    const parsed = JSON.parse(plaintext ?? "{}") as {
      seq: number;
      msg: { type: string };
    };
    expect(parsed.seq).toBe(0);
    expect(parsed.msg.type).toBe("client_capabilities");
  });

  it("waits for fallback SRP before notifying after invalid resume", async () => {
    const onAuthenticated = vi.fn();
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "test-password",
      { onAuthenticated },
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      storedSession: {
        wsUrl: string;
        username: string;
        sessionId: string;
        sessionKey: string;
        resumeProtocolVersion?: number;
      } | null;
      srpSession: {
        verifyServer: (m2: string) => Promise<boolean>;
        getSessionKey: () => Uint8Array;
      };
      connectionState: string;
      sessionKey: Uint8Array | null;
      startFullSrpHandshake: (reject: (err: Error) => void) => Promise<void>;
      handleSrpResumeResponse: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
      handleSrpVerify: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send, close: vi.fn() };
    conn.storedSession = {
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId: "sess-invalid-resume",
      sessionKey: bytesBase64(generateRandomKey()),
      resumeProtocolVersion: 3,
    };
    conn.startFullSrpHandshake = vi.fn(async () => {
      conn.connectionState = "srp_hello_sent";
    });

    const resumeResolve = vi.fn();
    const resumeReject = vi.fn();
    await conn.handleSrpResumeResponse(
      JSON.stringify({ type: "srp_invalid", reason: "expired" }),
      resumeResolve,
      resumeReject,
    );

    expect(conn.startFullSrpHandshake).toHaveBeenCalledTimes(1);
    expect(resumeResolve).not.toHaveBeenCalled();
    expect(resumeReject).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();

    const rawKey = generateRandomKey();
    const baseSessionKey = deriveSecretboxKey(rawKey);
    const sessionId = "sess-fallback-srp";
    const transportNonce = nonceBase64(19);
    conn.srpSession = {
      verifyServer: vi.fn().mockResolvedValue(true),
      getSessionKey: vi.fn().mockReturnValue(rawKey),
    };

    const verifyResolve = vi.fn();
    const verifyReject = vi.fn();
    await conn.handleSrpVerify(
      JSON.stringify({
        type: "srp_verify",
        M2: "abc123",
        sessionId,
        transportNonce,
        serverInfoProof: srpVerifyServerInfoProof({
          sessionId,
          transportNonce,
          key: baseSessionKey,
        }),
      }),
      verifyResolve,
      verifyReject,
    );

    expect(verifyResolve).toHaveBeenCalledTimes(1);
    expect(verifyReject).not.toHaveBeenCalled();
    expect(onAuthenticated).toHaveBeenCalledTimes(1);
    expect(conn.sessionKey).not.toBeNull();
  });

  it("records unstamped stored sessions as protocol 2 after grace resume", async () => {
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "",
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
        onmessage?: unknown;
      };
      storedSession: {
        wsUrl: string;
        username: string;
        sessionId: string;
        sessionKey: string;
        resumeProtocolVersion?: number;
      };
      pendingResumeClientNonce: string | null;
      pendingResumeServerNonce: string | null;
      handleSrpResumeResponse: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    conn.ws = { readyState: 1, send, close: vi.fn() };
    const sessionId = "sess-unstamped-resume";
    const serverNonce = nonceBase64(16);
    conn.storedSession = {
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId,
      sessionKey: bytesBase64(generateRandomKey()),
    };
    conn.pendingResumeClientNonce = nonceBase64(15);
    conn.pendingResumeServerNonce = serverNonce;

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpResumeResponse(
      JSON.stringify({
        type: "srp_resumed",
        sessionId,
        transportNonce: serverNonce,
      }),
      resolve,
      reject,
    );

    expect(resolve).toHaveBeenCalledTimes(1);
    expect(reject).not.toHaveBeenCalled();
    expect(conn.storedSession.resumeProtocolVersion).toBe(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rejects protocol 2 resume when the transport nonce is missing", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "",
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      storedSession: {
        wsUrl: string;
        username: string;
        sessionId: string;
        sessionKey: string;
        resumeProtocolVersion?: number;
      };
      connectionState: string;
      pendingResumeClientNonce: string | null;
      pendingResumeServerNonce: string | null;
      handleSrpResumeResponse: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    const close = vi.fn();
    conn.ws = { readyState: 1, send, close };
    const sessionId = "sess-v2-no-nonce";
    conn.storedSession = {
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId,
      sessionKey: bytesBase64(generateRandomKey()),
      resumeProtocolVersion: 2,
    };
    conn.pendingResumeClientNonce = nonceBase64(17);
    conn.pendingResumeServerNonce = nonceBase64(18);

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpResumeResponse(
      JSON.stringify({
        type: "srp_resumed",
        sessionId,
      }),
      resolve,
      reject,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]?.message).toBe(
      "Resume server verification failed",
    );
    expect(conn.connectionState).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "[SecureConnection] Resume server proof failed",
    );
  });

  it("rejects protocol 3 resume when the server proof is missing", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "",
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      storedSession: {
        wsUrl: string;
        username: string;
        sessionId: string;
        sessionKey: string;
        resumeProtocolVersion?: number;
      };
      connectionState: string;
      minimumResumeProtocolVersion: number | null;
      pendingResumeClientNonce: string | null;
      pendingResumeServerNonce: string | null;
      handleSrpResumeResponse: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    const close = vi.fn();
    conn.ws = { readyState: 1, send, close };
    const sessionId = "sess-resume";
    conn.storedSession = {
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId,
      sessionKey: bytesBase64(generateRandomKey()),
      resumeProtocolVersion: 3,
    };
    conn.pendingResumeClientNonce = nonceBase64(7);
    conn.pendingResumeServerNonce = nonceBase64(8);

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpResumeResponse(
      JSON.stringify({
        type: "srp_resumed",
        sessionId,
        transportNonce: conn.pendingResumeServerNonce,
      }),
      resolve,
      reject,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]?.message).toBe(
      "Resume server verification failed",
    );
    expect(conn.connectionState).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "[SecureConnection] Resume would downgrade authenticated protocol",
    );
  });

  it("rejects resume when server proof downgrades the pinned protocol", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const conn = new SecureConnection(
      "ws://localhost:3400/api/ws",
      "test-user",
      "",
    ) as unknown as {
      ws: {
        readyState: number;
        send: ReturnType<typeof vi.fn>;
        close: ReturnType<typeof vi.fn>;
      };
      storedSession: {
        wsUrl: string;
        username: string;
        sessionId: string;
        sessionKey: string;
        resumeProtocolVersion?: number;
      };
      connectionState: string;
      minimumResumeProtocolVersion: number | null;
      pendingResumeClientNonce: string | null;
      pendingResumeServerNonce: string | null;
      handleSrpResumeResponse: (
        data: string,
        resolve: () => void,
        reject: (err: Error) => void,
      ) => Promise<void>;
    };

    const send = vi.fn();
    const close = vi.fn();
    conn.ws = { readyState: 1, send, close };
    const baseSessionKey = generateRandomKey();
    const sessionId = "sess-resume";
    const clientNonce = nonceBase64(9);
    const serverNonce = nonceBase64(10);
    conn.storedSession = {
      wsUrl: "ws://localhost:3400/api/ws",
      username: "test-user",
      sessionId,
      sessionKey: bytesBase64(baseSessionKey),
      resumeProtocolVersion: 3,
    };
    conn.pendingResumeClientNonce = clientNonce;
    conn.pendingResumeServerNonce = serverNonce;
    conn.minimumResumeProtocolVersion = 3;

    const resolve = vi.fn();
    const reject = vi.fn();
    await conn.handleSrpResumeResponse(
      JSON.stringify({
        type: "srp_resumed",
        sessionId,
        transportNonce: serverNonce,
        serverProof: resumeServerProof({
          sessionId,
          serverNonce,
          clientNonce,
          resumeProtocolVersion: 2,
          key: baseSessionKey,
        }),
      }),
      resolve,
      reject,
    );

    expect(resolve).not.toHaveBeenCalled();
    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]?.message).toBe(
      "Resume server verification failed",
    );
    expect(conn.connectionState).toBe("failed");
    expect(send).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledTimes(1);
    expect(errorLog).toHaveBeenCalledWith(
      "[SecureConnection] Resume server proof failed",
    );
  });
});
