import {
  TRANSPORT_CHUNK_HEADER_SIZE,
  TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
} from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RELAY_WEBSOCKET_MAX_MESSAGE_BYTES,
  loadConfig,
} from "../src/config.js";
import { createRelayServer } from "../src/server.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("relay WebSocket message admission", () => {
  it("retains the 100 MiB compatibility default for unchunked older peers", () => {
    expect(DEFAULT_RELAY_WEBSOCKET_MAX_MESSAGE_BYTES).toBe(100 * 1024 * 1024);
  });

  it("accepts an operator override", () => {
    vi.stubEnv("RELAY_WEBSOCKET_MAX_MESSAGE_BYTES", String(1024 * 1024));
    expect(loadConfig().webSocketMaxMessageBytes).toBe(1024 * 1024);
  });

  it("keeps complete transport chunks below the incumbent mux limit", () => {
    vi.stubEnv("RELAY_MUX_MAX_FRAME_BYTES", "");
    expect(
      1 + TRANSPORT_CHUNK_HEADER_SIZE + TRANSPORT_CHUNK_PAYLOAD_MAX_BYTES,
    ).toBeLessThanOrEqual(loadConfig().muxMaxFrameBytes);
  });

  it("applies a 1 MiB limit to the WebSocket parser", async () => {
    const relay = await createRelayServer({
      inMemoryDb: true,
      disableTelemetry: true,
      disablePrettyPrint: true,
      webSocketMaxMessageBytes: 1024 * 1024,
    });

    try {
      expect(relay.wss.options.maxPayload).toBe(1024 * 1024);
    } finally {
      await relay.close();
    }
  });
});
