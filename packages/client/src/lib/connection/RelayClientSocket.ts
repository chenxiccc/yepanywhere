import type { RelayChannel } from "@yep-anywhere/shared";
import {
  DEFAULT_RELAY_CHANNEL,
  isRelayClientConnected,
  isRelayClientError,
} from "@yep-anywhere/shared";

export interface OpenRelayClientSocketOptions {
  channel?: RelayChannel;
  connectTimeoutMs?: number;
  onOpen?: () => void;
  relayUrl: string;
  relayUsername: string;
  serverTimeoutMs?: number;
  signal?: AbortSignal;
}

function abortError(): Error {
  return new DOMException("Relay connection aborted", "AbortError");
}

function waitForRelayOpen(
  ws: WebSocket,
  options: OpenRelayClientSocketOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", handleAbort);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const handleAbort = () => {
      ws.close();
      finish(abortError());
    };
    const timeout = setTimeout(() => {
      ws.close();
      finish(new Error("Relay connection timeout"));
    }, options.connectTimeoutMs ?? 15_000);

    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    ws.onopen = () => {
      options.onOpen?.();
      finish();
    };
    ws.onerror = () => {
      finish(new Error("Failed to connect to relay server"));
    };
  });
}

function waitForServerPair(
  ws: WebSocket,
  options: OpenRelayClientSocketOptions,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", handleAbort);
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    const handleAbort = () => {
      ws.close();
      finish(abortError());
    };
    const timeout = setTimeout(() => {
      ws.close();
      finish(new Error("Waiting for server timed out"));
    }, options.serverTimeoutMs ?? 30_000);

    if (options.signal?.aborted) {
      handleAbort();
      return;
    }
    options.signal?.addEventListener("abort", handleAbort, { once: true });
    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data as string);
        if (isRelayClientConnected(message)) {
          finish();
        } else if (isRelayClientError(message)) {
          ws.close();
          finish(new Error(message.reason));
        } else {
          // Preserve the established pairing behavior: once a registered
          // server speaks, hand the socket to the secure protocol.
          finish();
        }
      } catch {
        ws.close();
        finish(new Error("Invalid relay response"));
      }
    };
    ws.onclose = () => {
      finish(new Error("Relay connection closed"));
    };
    ws.onerror = () => {
      finish(new Error("Relay connection error"));
    };
  });
}

export async function openRelayClientSocket(
  options: OpenRelayClientSocketOptions,
): Promise<WebSocket> {
  const ws = new WebSocket(options.relayUrl);
  ws.binaryType = "arraybuffer";

  try {
    await waitForRelayOpen(ws, options);
    const channel = options.channel ?? DEFAULT_RELAY_CHANNEL;
    ws.send(
      JSON.stringify(
        channel === DEFAULT_RELAY_CHANNEL
          ? {
              type: "client_connect",
              username: options.relayUsername,
            }
          : {
              type: "client_connect_channel",
              username: options.relayUsername,
              channel,
            },
      ),
    );
    await waitForServerPair(ws, options);
    return ws;
  } catch (error) {
    ws.close();
    throw error;
  }
}
