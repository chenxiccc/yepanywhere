import type {
  DeviceServerMessage,
  RemoteClientMessage,
  StagedAttachmentRef,
  UploadedFile,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectionManager } from "../../connection/ConnectionManager";
import type { WebSocketConnection } from "../../connection/WebSocketConnection";
import type {
  Connection,
  ConnectionSpeechSocket,
  SessionSubscriptionOptions,
  StreamHandlers,
  Subscription,
} from "../../connection/types";
import {
  SecureSourceTransport,
  WebSocketSourceTransport,
} from "../MultiplexSourceTransport";

class FakeMultiplexConnection implements Connection {
  readonly mode = "secure" as const;
  manager: ConnectionManager | null = null;
  readonly fetchMock = vi.fn();
  readonly fetchBlobMock = vi.fn();
  readonly upload = vi.fn(
    async (
      _projectId: string,
      _sessionId: string,
      file: File,
    ): Promise<UploadedFile> => ({
      id: `${this.id}-file`,
      name: file.name,
      originalName: file.name,
      path: `/uploads/${file.name}`,
      size: file.size,
      mimeType: file.type,
    }),
  );
  readonly uploadStagedAttachment = vi.fn(
    async (file: File): Promise<StagedAttachmentRef> => ({
      id: `${this.id}-staged`,
      batchId: `${this.id}-batch`,
      originalName: file.name,
      name: file.name,
      size: file.size,
      mimeType: file.type,
      createdAt: "2026-07-05T00:00:00.000Z",
      updatedAt: "2026-07-05T00:00:00.000Z",
    }),
  );
  readonly close = vi.fn();
  readonly reconnect = vi.fn(async () => {
    this.manager?.markConnected();
  });
  readonly forceReconnect = vi.fn(async () => {
    this.manager?.markConnected();
  });
  readonly sendPing = vi.fn();
  readonly sendMessage = vi.fn((_msg: RemoteClientMessage) => undefined);
  private readonly deviceHandlers = new Set<
    (msg: DeviceServerMessage) => void
  >();

  constructor(readonly id: string) {}

  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    this.fetchMock(path, init);
    return { from: this.id, path } as T;
  }

  async fetchBlob(path: string): Promise<Blob> {
    this.fetchBlobMock(path);
    return new Blob(["ok"]);
  }

  setConnectionManager(manager: ConnectionManager | null): void {
    this.manager = manager;
  }

  subscribeSession(
    _sessionId: string,
    handlers: StreamHandlers,
    _lastEventId?: string,
    _options?: SessionSubscriptionOptions,
  ): Subscription {
    handlers.onOpen?.();
    return { close: () => handlers.onClose?.() };
  }

  subscribeActivity(handlers: StreamHandlers): Subscription {
    handlers.onOpen?.();
    return { close: () => handlers.onClose?.() };
  }

  subscribeGlossary(
    _projectId: string,
    handlers: StreamHandlers,
  ): Subscription {
    handlers.onOpen?.();
    return { close: () => handlers.onClose?.() };
  }

  subscribeSessionWatch(
    _sessionId: string,
    handlers: StreamHandlers,
  ): Subscription {
    handlers.onOpen?.();
    return { close: () => handlers.onClose?.() };
  }

  onDeviceMessage(handler: (msg: DeviceServerMessage) => void): () => void {
    this.deviceHandlers.add(handler);
    return () => {
      this.deviceHandlers.delete(handler);
    };
  }

  openSpeechSocket(): Promise<ConnectionSpeechSocket> {
    return Promise.resolve({
      readyState: WebSocket.OPEN,
      bufferedAmount: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      onclose: null,
      send: vi.fn(),
      close: vi.fn(),
    });
  }
}

function streamChannel(transport: WebSocketSourceTransport) {
  return transport.status
    .getSnapshot()
    .channels.find((channel) => channel.name === "multiplex-websocket");
}

describe("multiplex source transports", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects empty-slot demand fetches with a retryable typed timeout", async () => {
    vi.useFakeTimers();
    const transport = new SecureSourceTransport({ readyTimeoutMs: 25 });

    const pending = transport.fetch("/sessions");
    const assertion = expect(pending).rejects.toMatchObject({
      code: "SOURCE_TRANSPORT_NOT_READY",
      retryable: true,
      transportKind: "secure",
      channel: "secure-websocket",
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    transport.dispose();
  });

  it("rejects empty-slot demand fetches immediately when disposed", async () => {
    const transport = new SecureSourceTransport({ readyTimeoutMs: 1000 });

    const pending = transport.fetch("/sessions");
    transport.dispose();

    await expect(pending).rejects.toMatchObject({
      code: "SOURCE_TRANSPORT_DISPOSED",
      retryable: false,
      transportKind: "secure",
    });
  });

  it("resolves pending fetches on attach and preserves facade identity across replacement", async () => {
    vi.useFakeTimers();
    const transport = new SecureSourceTransport({ readyTimeoutMs: 1000 });
    const facade = transport;
    const first = new FakeMultiplexConnection("first");
    const second = new FakeMultiplexConnection("second");

    const pending = transport.fetch("/projects");
    transport.attach(
      first as unknown as Parameters<typeof transport.attach>[0],
    );

    await expect(pending).resolves.toEqual({
      from: "first",
      path: "/projects",
    });
    expect(transport.status.getSnapshot()).toMatchObject({
      kind: "secure",
      state: "ready",
    });

    transport.attach(
      second as unknown as Parameters<typeof transport.attach>[0],
    );
    await expect(facade.fetch("/projects")).resolves.toEqual({
      from: "second",
      path: "/projects",
    });
    expect(first.close).not.toHaveBeenCalled();

    transport.dispose();
    expect(second.close).toHaveBeenCalledTimes(1);
  });

  it("reports retryable raw subscription errors while detached", async () => {
    const transport = new SecureSourceTransport({ readyTimeoutMs: 25 });
    const onError = vi.fn();
    const subscription = transport.subscribeActivity({
      onEvent: vi.fn(),
      onError,
    });

    await Promise.resolve();

    expect(onError.mock.calls[0]?.[0]).toMatchObject({
      code: "SOURCE_TRANSPORT_NOT_READY",
      retryable: true,
      transportKind: "secure",
    });
    subscription.close();
    transport.dispose();
  });

  it("reports reconnecting state before the manager backoff fires", async () => {
    const transport = new WebSocketSourceTransport({ readyTimeoutMs: 25 });
    const connection = new FakeMultiplexConnection("ws");

    transport.attach(connection as unknown as WebSocketConnection);
    expect(streamChannel(transport)).toMatchObject({ state: "connected" });

    connection.manager?.handleClose(new Error("socket dropped"));
    expect(transport.status.getSnapshot().state).toBe("reconnecting");
    expect(streamChannel(transport)).toMatchObject({
      state: "reconnecting",
    });

    await Promise.resolve();
    expect(connection.reconnect).not.toHaveBeenCalled();

    connection.manager?.markConnected();
    expect(transport.status.getSnapshot().state).toBe("ready");
    expect(streamChannel(transport)).toMatchObject({ state: "connected" });
    transport.dispose();
  });

  it("delegates demand fetches while reconnecting", async () => {
    vi.useFakeTimers();
    const transport = new WebSocketSourceTransport({ readyTimeoutMs: 25 });
    const connection = new FakeMultiplexConnection("ws");

    transport.attach(connection as unknown as WebSocketConnection);
    connection.manager?.handleClose(new Error("socket dropped"));

    expect(transport.status.getSnapshot().state).toBe("reconnecting");
    await expect(transport.fetch("/projects")).resolves.toEqual({
      from: "ws",
      path: "/projects",
    });
    expect(connection.fetchMock).toHaveBeenCalledWith("/projects", undefined);
    expect(connection.reconnect).not.toHaveBeenCalled();

    transport.dispose();
  });

  it("fast-fails demand fetches after the manager gives up", async () => {
    vi.useFakeTimers();
    const transport = new WebSocketSourceTransport({
      readyTimeoutMs: 25,
      connectionManagerConfig: {
        baseDelayMs: 1,
        jitterFactor: 0,
        maxAttempts: 1,
      },
    });
    const connection = new FakeMultiplexConnection("ws");
    connection.reconnect.mockRejectedValueOnce(new Error("server offline"));

    transport.attach(connection as unknown as WebSocketConnection);
    connection.manager?.handleClose(new Error("socket dropped"));
    await vi.advanceTimersByTimeAsync(1);

    expect(transport.status.getSnapshot().state).toBe("disconnected");
    expect(streamChannel(transport)).toMatchObject({
      state: "disconnected",
      lastError: "Reconnection failed after 1 attempts",
    });
    await expect(transport.fetch("/projects")).rejects.toMatchObject({
      code: "SOURCE_TRANSPORT_DISCONNECTED",
      retryable: false,
      transportKind: "websocket",
      state: "disconnected",
      channel: "multiplex-websocket",
      lastError: "Reconnection failed after 1 attempts",
    });
    expect(connection.fetchMock).not.toHaveBeenCalled();

    transport.dispose();
  });
});
