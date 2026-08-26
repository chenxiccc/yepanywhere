import {
  decodeJsonFrame,
  type RemoteClientMessage,
  type UploadedFile,
  type YepMessage,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type { WebSocketLike } from "../../../api/upload";
import type { WebSocketConnectionSocket } from "../../connection/WebSocketConnection";
import { LocalhostSourceTransport } from "../index";

class FakeStreamSocket implements WebSocketConnectionSocket {
  readyState: number = WebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  sent: unknown[] = [];
  closeCalls = 0;

  constructor(readonly url: string) {}

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSED;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  serverMessage(message: YepMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) } as MessageEvent);
  }
}

class FakeUploadSocket implements WebSocketLike {
  readyState: number = WebSocket.CONNECTING;
  bufferedAmount = 0;
  sent: (string | ArrayBuffer | Uint8Array)[] = [];
  closeCalls = 0;
  private listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {}

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = WebSocket.CLOSED;
  }

  addEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (ev: WebSocketEventMap[K]) => void,
  ): void {
    if (!this.listeners.has(type)) {
      this.listeners.set(type, new Set());
    }
    this.listeners.get(type)?.add(listener as (event: Event) => void);
  }

  removeEventListener<K extends keyof WebSocketEventMap>(
    type: K,
    listener: (ev: WebSocketEventMap[K]) => void,
  ): void {
    this.listeners.get(type)?.delete(listener as (event: Event) => void);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.emit("open", new Event("open"));
  }

  complete(file: UploadedFile): void {
    this.emit("message", {
      data: JSON.stringify({ type: "complete", file }),
    } as MessageEvent);
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

function flushPromises(): Promise<void> {
  return Promise.resolve().then(() => undefined);
}

function streamChannel(transport: LocalhostSourceTransport) {
  return transport.status
    .getSnapshot()
    .channels.find((channel) => channel.name === "stream-websocket");
}

function uploadChannel(transport: LocalhostSourceTransport) {
  return transport.status
    .getSnapshot()
    .channels.find((channel) => channel.name === "upload-websocket");
}

function testFile(name: string, body: string, type: string): File {
  const bytes = new TextEncoder().encode(body);
  return {
    name,
    type,
    size: bytes.byteLength,
    slice(start = 0, end = bytes.byteLength) {
      const chunk = bytes.slice(start, end);
      return {
        arrayBuffer: async () => chunk.buffer.slice(0),
      };
    },
  } as File;
}

describe("LocalhostSourceTransport", () => {
  it("forces mutable file blobs to revalidate without weakening immutable media", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => new Response("file-bytes"));
    const transport = new LocalhostSourceTransport();

    try {
      await transport.fetchBlob("/local-image?path=%2Ftmp%2Fplot.png");
      await transport.fetchBlob("/local-file?path=%2Ftmp%2Fnotes.txt");
      await transport.fetchBlob("/projects/project-1/files/raw?path=plot.png");
      await transport.fetchBlob(
        "/projects/project-1/sessions/session-1/media/media-1",
      );

      expect(fetchMock.mock.calls.map(([, init]) => init?.cache)).toEqual([
        "no-cache",
        "no-cache",
        "no-cache",
        undefined,
      ]);
    } finally {
      transport.dispose();
      fetchMock.mockRestore();
    }
  });

  it("keeps source state ready while reporting stream channel transitions", async () => {
    const streamSockets: FakeStreamSocket[] = [];
    const transport = new LocalhostSourceTransport({
      streamWebSocketFactory: (url) => {
        const socket = new FakeStreamSocket(url);
        streamSockets.push(socket);
        return socket;
      },
    });
    const listener = vi.fn();
    transport.status.subscribe(listener);

    expect(transport.status.getSnapshot()).toMatchObject({
      kind: "localhost",
      state: "ready",
    });
    expect(streamChannel(transport)).toMatchObject({
      name: "stream-websocket",
      state: "idle",
      activeSubscriptions: 0,
    });

    const subscription = transport.subscribeSession("session-1", {
      onEvent: vi.fn(),
    });
    expect(streamSockets).toHaveLength(1);
    expect(transport.status.getSnapshot().state).toBe("ready");
    expect(streamChannel(transport)).toMatchObject({
      state: "connecting",
      activeSubscriptions: 1,
    });

    streamSockets[0]?.open();
    await flushPromises();

    expect(transport.status.getSnapshot().state).toBe("ready");
    expect(streamChannel(transport)).toMatchObject({
      state: "connected",
      activeSubscriptions: 1,
    });
    expect(listener).toHaveBeenCalled();

    subscription.close();
    expect(streamChannel(transport)).toMatchObject({
      state: "connected",
      activeSubscriptions: 0,
    });
    transport.dispose();
  });

  it("records stream heartbeats and closes its owned stream socket on dispose", async () => {
    const streamSockets: FakeStreamSocket[] = [];
    const onEvent = vi.fn();
    const transport = new LocalhostSourceTransport({
      streamWebSocketFactory: (url) => {
        const socket = new FakeStreamSocket(url);
        streamSockets.push(socket);
        return socket;
      },
    });

    transport.subscribeActivity({ onEvent });
    const socket = streamSockets[0];
    expect(socket).toBeDefined();
    if (!socket) throw new Error("Expected stream socket.");
    socket.open();
    await flushPromises();

    const subscribeMessage = socket.sent
      .map((frame) =>
        decodeJsonFrame<RemoteClientMessage>(frame as ArrayBuffer | Uint8Array),
      )
      .find((message) => message.type === "subscribe");
    if (subscribeMessage?.type !== "subscribe") {
      throw new Error("Expected activity subscription frame.");
    }
    socket.serverMessage({
      type: "event",
      subscriptionId: subscribeMessage.subscriptionId,
      eventType: "heartbeat",
      data: null,
    });
    expect(onEvent).toHaveBeenCalledWith("heartbeat", undefined, null);

    transport.dispose();

    expect(socket.closeCalls).toBe(1);
    expect(transport.status.getSnapshot()).toMatchObject({
      state: "ready",
    });
    expect(streamChannel(transport)).toMatchObject({
      state: "disconnected",
    });
  });

  it("reports upload channel active count ephemerally", async () => {
    const uploadSockets: FakeUploadSocket[] = [];
    const transport = new LocalhostSourceTransport({
      uploadWebSocketFactory: (url) => {
        const socket = new FakeUploadSocket(url);
        uploadSockets.push(socket);
        return socket;
      },
    });
    const uploadedFile: UploadedFile = {
      id: "file-1",
      name: "file-1_note.txt",
      originalName: "note.txt",
      path: "/uploads/file-1_note.txt",
      size: 4,
      mimeType: "text/plain",
    };

    const uploadPromise = transport.upload(
      "project-1",
      "session-1",
      testFile("note.txt", "note", "text/plain"),
      { maxBytesPerSecond: 0 },
    );

    expect(uploadChannel(transport)).toMatchObject({
      name: "upload-websocket",
      state: "connecting",
      activeSubscriptions: 1,
    });

    const socket = uploadSockets[0];
    expect(socket).toBeDefined();
    if (!socket) throw new Error("Expected upload socket.");
    socket.open();
    await flushPromises();
    expect(uploadChannel(transport)).toMatchObject({
      name: "upload-websocket",
      state: "connected",
      activeSubscriptions: 1,
    });
    socket.complete(uploadedFile);

    await expect(uploadPromise).resolves.toEqual(uploadedFile);
    expect(uploadChannel(transport)).toBeUndefined();
    transport.dispose();
  });
});
