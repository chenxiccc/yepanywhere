import {
  BinaryFormat,
  TRANSPORT_CHUNK_HEADER_SIZE,
  TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
  TransportChunkReassembler,
  type YepMessage,
  decodeJsonFrame,
} from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { decryptBinaryEnvelope } from "../../src/crypto/index.js";
import {
  createConnectionState,
  createSendFn,
} from "../../src/routes/ws-relay-handlers.js";

function largeResponse(): YepMessage {
  return {
    type: "response",
    id: "large-response",
    status: 200,
    body: { text: "transport-frame-content".repeat(30_000) },
  };
}

describe("WebSocket response framing", () => {
  it("chunks and reassembles a negotiated encrypted response", () => {
    const frames: ArrayBuffer[] = [];
    const ws = {
      send: vi.fn((frame: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => {
        if (typeof frame === "string") {
          throw new Error("Expected a binary response frame");
        }
        frames.push(
          frame instanceof ArrayBuffer
            ? frame
            : frame.buffer.slice(
                frame.byteOffset,
                frame.byteOffset + frame.byteLength,
              ),
        );
      }),
      close: vi.fn(),
    };
    const state = createConnectionState();
    const sessionKey = new Uint8Array(32).fill(7);
    state.authState = "authenticated";
    state.sessionKey = sessionKey;
    state.supportedFormats = new Set([
      BinaryFormat.JSON,
      BinaryFormat.TRANSPORT_CHUNK,
    ]);

    createSendFn(ws, state)(largeResponse());

    expect(frames.length).toBeGreaterThan(1);
    expect(
      frames.every(
        (frame) =>
          frame.byteLength <=
          1 + TRANSPORT_CHUNK_HEADER_SIZE + TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
      ),
    ).toBe(true);
    const reassembler = new TransportChunkReassembler();
    let envelope: Uint8Array | undefined;
    for (const frame of frames) {
      envelope = reassembler.accept(frame) ?? envelope;
    }
    expect(envelope).toBeDefined();
    const plaintext = decryptBinaryEnvelope(envelope as Uint8Array, sessionKey);
    expect(plaintext).not.toBeNull();
    expect(JSON.parse(plaintext as string)).toEqual({
      seq: 0,
      msg: largeResponse(),
    });
    expect(ws.close).not.toHaveBeenCalled();
  });

  it("keeps one complete binary frame for clients without chunk support", () => {
    const frames: ArrayBuffer[] = [];
    const ws = {
      send: vi.fn((frame: string | ArrayBuffer | Uint8Array<ArrayBuffer>) => {
        expect(typeof frame).not.toBe("string");
        frames.push(frame as ArrayBuffer);
      }),
      close: vi.fn(),
    };
    const state = createConnectionState();
    state.connectionPolicy = "local_unrestricted";
    state.authState = "authenticated";
    state.useBinaryFrames = true;

    createSendFn(ws, state)(largeResponse());

    expect(frames).toHaveLength(1);
    expect(frames[0].byteLength).toBeGreaterThan(
      TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
    );
    expect(decodeJsonFrame(frames[0])).toEqual(largeResponse());
    expect(ws.close).not.toHaveBeenCalled();
  });
});
