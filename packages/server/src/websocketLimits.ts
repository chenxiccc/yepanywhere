import type { WebSocketServer } from "ws";

export const MAX_INBOUND_WEBSOCKET_MESSAGE_BYTES = 100 * 1024 * 1024;

export function configureInboundWebSocketMessageLimit(
  server: Pick<WebSocketServer, "options">,
): void {
  server.options.maxPayload = MAX_INBOUND_WEBSOCKET_MESSAGE_BYTES;
}
