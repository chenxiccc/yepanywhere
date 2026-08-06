import { WebSocketServer } from "ws";
import { describe, expect, it } from "vitest";
import {
  MAX_INBOUND_WEBSOCKET_MESSAGE_BYTES,
  configureInboundWebSocketMessageLimit,
} from "../src/websocketLimits.js";

describe("configureInboundWebSocketMessageLimit", () => {
  it("makes the ws 100 MiB compatibility allowance server-owned", () => {
    const server = new WebSocketServer({ noServer: true });

    expect(MAX_INBOUND_WEBSOCKET_MESSAGE_BYTES).toBe(100 * 1024 * 1024);
    expect(server.options.maxPayload).toBe(100 * 1024 * 1024);
    configureInboundWebSocketMessageLimit(server);
    expect(server.options.maxPayload).toBe(MAX_INBOUND_WEBSOCKET_MESSAGE_BYTES);
  });
});
