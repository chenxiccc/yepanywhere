import {
  BinaryFormat,
  type ClientCapabilities,
  decodeJsonFrame,
  encodeJsonFrame,
  encodeTransportChunkFrame,
  encodeTransportChunkFrames,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import {
  WebSocketConnection,
  type WebSocketConnectionSocket,
} from "../WebSocketConnection";

class TestSocket implements WebSocketConnectionSocket {
  readyState: number = WebSocket.CONNECTING;
  binaryType: BinaryType = "blob";
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly sent: Array<string | ArrayBuffer | Uint8Array> = [];
  readonly close = vi.fn((code?: number, reason?: string) => {
    this.readyState = WebSocket.CLOSED;
    void code;
    void reason;
  });

  send(data: string | ArrayBuffer | Uint8Array): void {
    this.sent.push(data);
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(data: string | ArrayBuffer): void {
    this.onmessage?.(new MessageEvent("message", { data }));
  }
}

describe("WebSocketConnection transport chunks", () => {
  it("negotiates chunks and reassembles a large server message", async () => {
    const socket = new TestSocket();
    const connection = new WebSocketConnection({
      createWebSocket: () => socket,
    });
    const connected = connection.ensureConnected();
    socket.open();
    await connected;

    expect(socket.sent).toHaveLength(1);
    const capabilities = decodeJsonFrame<ClientCapabilities>(
      socket.sent[0] as ArrayBuffer,
    );
    expect(capabilities).toEqual({
      type: "client_capabilities",
      version: "unknown",
      capabilityBits: [],
      formats: [
        BinaryFormat.JSON,
        BinaryFormat.BINARY_UPLOAD,
        BinaryFormat.TRANSPORT_CHUNK,
      ],
    });

    const onPong = vi.fn();
    connection.setOnPong(onPong);
    const message = encodeJsonFrame({
      type: "pong",
      id: "chunked-direct-pong",
      padding: "low-level-transport-padding".repeat(30_000),
    });
    const chunks = Array.from(encodeTransportChunkFrames(9, message));
    expect(chunks.length).toBeGreaterThan(1);

    for (const chunk of chunks.slice(0, -1)) {
      socket.receive(chunk);
      expect(onPong).not.toHaveBeenCalled();
    }
    socket.receive(chunks.at(-1) as ArrayBuffer);

    expect(onPong).toHaveBeenCalledOnce();
    expect(onPong).toHaveBeenCalledWith("chunked-direct-pong");
    expect(socket.close).not.toHaveBeenCalled();
  });

  it("closes when a text message interrupts chunk reassembly", async () => {
    const socket = new TestSocket();
    const connection = new WebSocketConnection({
      createWebSocket: () => socket,
    });
    const connected = connection.ensureConnected();
    socket.open();
    await connected;
    const onPong = vi.fn();
    connection.setOnPong(onPong);

    socket.receive(
      encodeTransportChunkFrame({
        messageId: 12,
        offset: 0,
        totalBytes: 2,
        data: new Uint8Array([1]),
      }),
    );
    socket.receive(JSON.stringify({ type: "pong", id: "interleaved-pong" }));

    expect(onPong).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledWith(
      1002,
      "Transport chunk sequence interrupted",
    );
  });
});
