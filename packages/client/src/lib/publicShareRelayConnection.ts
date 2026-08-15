import {
  PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES,
  type RelayResponse,
} from "@yep-anywhere/shared";

export interface PublicShareRelayRequestOptions {
  path: string;
  relayUrl: string;
  relayUsername: string;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

export const PUBLIC_SHARE_RELAY_METADATA_FRAME_MAX_BYTES = 128 * 1024;
export const PUBLIC_SHARE_RELAY_CHUNK_FRAME_MAX_BYTES = 512 * 1024;

const PUBLIC_SHARE_RELAY_TIMEOUT_MS = 30_000;
const PUBLIC_SHARE_RELAY_HEADER_MAX_COUNT = 64;
const PUBLIC_SHARE_RELAY_HEADER_NAME_MAX_CHARS = 128;
const PUBLIC_SHARE_RELAY_HEADER_VALUE_MAX_CHARS = 4096;

function generateRequestId(): string {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function publicShareAbortError(): Error {
  const error = new Error("Share request cancelled");
  error.name = "AbortError";
  return error;
}

export function asPublicShareError(error: unknown): Error {
  return error instanceof Error ? error : new Error("Share transfer failed");
}

function exceedsUtf8ByteLimit(text: string, maxBytes: number): boolean {
  return (
    text.length > maxBytes ||
    new TextEncoder().encode(text).byteLength > maxBytes
  );
}

async function decodeWebSocketData(
  data: MessageEvent["data"],
  maxBytes: number,
): Promise<string> {
  if (typeof data === "string") {
    if (exceedsUtf8ByteLimit(data, maxBytes)) {
      throw new Error("Relay response is too large");
    }
    return data;
  }
  if (data instanceof Blob) {
    if (data.size > maxBytes) {
      throw new Error("Relay response is too large");
    }
    return await data.text();
  }
  if (data instanceof ArrayBuffer) {
    if (data.byteLength > maxBytes) {
      throw new Error("Relay response is too large");
    }
    return new TextDecoder().decode(data);
  }
  throw new Error("Relay returned an invalid response");
}

function hasBoundedRelayResponseHeaders(value: unknown): boolean {
  if (value === undefined) return true;
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entries = Object.entries(value);
  return (
    entries.length <= PUBLIC_SHARE_RELAY_HEADER_MAX_COUNT &&
    entries.every(
      ([name, headerValue]) =>
        name.length <= PUBLIC_SHARE_RELAY_HEADER_NAME_MAX_CHARS &&
        typeof headerValue === "string" &&
        headerValue.length <= PUBLIC_SHARE_RELAY_HEADER_VALUE_MAX_CHARS,
    )
  );
}

export class PublicShareRelayConnection {
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (error: Error) => void;
  private readySettled = false;
  private connectTimeout: ReturnType<typeof setTimeout> | null;
  private pending:
    | {
        id: string;
        resolve: (response: RelayResponse) => void;
        reject: (error: Error) => void;
        timeout: ReturnType<typeof setTimeout>;
        maxResponseBytes: number;
      }
    | undefined;
  private closedIntentionally = false;
  private terminalError: Error | undefined;
  private readonly signal?: AbortSignal;
  private readonly abortListener = () => {
    this.close(publicShareAbortError());
  };

  constructor(relayUrl: string, relayUsername: string, signal?: AbortSignal) {
    this.signal = signal;
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    void this.ready.catch(() => undefined);
    this.ws = new WebSocket(relayUrl);
    this.connectTimeout = setTimeout(() => {
      this.fail(new Error("Share request timed out"));
      this.close();
    }, PUBLIC_SHARE_RELAY_TIMEOUT_MS);

    this.ws.onopen = () => {
      this.ws.send(
        JSON.stringify({ type: "client_connect", username: relayUsername }),
      );
    };
    this.ws.onmessage = (event) => {
      void this.handleMessage(event);
    };
    this.ws.onerror = () => {
      this.close(new Error("Relay connection failed"));
    };
    this.ws.onclose = () => {
      if (!this.closedIntentionally) {
        this.failTerminal(new Error("Relay connection closed"));
      }
    };
    this.signal?.addEventListener("abort", this.abortListener, { once: true });
    if (this.signal?.aborted) {
      this.abortListener();
    }
  }

  async request(
    path: string,
    maxResponseBytes = PUBLIC_SHARE_LEGACY_RELAY_FRAME_MAX_BYTES,
  ): Promise<RelayResponse> {
    await this.ready;
    if (this.signal?.aborted) throw publicShareAbortError();
    if (this.terminalError) throw this.terminalError;
    if (this.closedIntentionally || this.ws.readyState >= 2) {
      throw new Error("Relay connection closed");
    }
    if (this.pending) {
      throw new Error("Public share relay requests must be sequential");
    }

    const id = generateRequestId();
    return await new Promise<RelayResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending = undefined;
        const error = new Error("Share request timed out");
        reject(error);
        this.close(error);
      }, PUBLIC_SHARE_RELAY_TIMEOUT_MS);
      this.pending = { id, resolve, reject, timeout, maxResponseBytes };
      try {
        this.ws.send(
          JSON.stringify({
            type: "request",
            id,
            method: "GET",
            path,
            headers: {},
          }),
        );
      } catch {
        clearTimeout(timeout);
        this.pending = undefined;
        const terminalError = new Error("Relay connection closed");
        this.failTerminal(terminalError);
        reject(terminalError);
      }
    });
  }

  isTerminal(): boolean {
    return (
      this.terminalError !== undefined ||
      this.closedIntentionally ||
      this.ws.readyState >= 2
    );
  }

  close(error = new Error("Relay connection closed")): void {
    if (this.closedIntentionally) return;
    this.failTerminal(error);
    this.closedIntentionally = true;
    this.signal?.removeEventListener("abort", this.abortListener);
    if (this.connectTimeout) {
      clearTimeout(this.connectTimeout);
      this.connectTimeout = null;
    }
    this.ws.onopen = null;
    this.ws.onmessage = null;
    this.ws.onerror = null;
    this.ws.onclose = null;
    this.ws.close();
  }

  private async handleMessage(event: MessageEvent): Promise<void> {
    let message: unknown;
    try {
      const maxResponseBytes =
        this.pending?.maxResponseBytes ??
        PUBLIC_SHARE_RELAY_METADATA_FRAME_MAX_BYTES;
      let text: string;
      if (typeof event.data === "string") {
        if (exceedsUtf8ByteLimit(event.data, maxResponseBytes)) {
          throw new Error("Relay response is too large");
        }
        text = event.data;
      } else {
        text = await decodeWebSocketData(event.data, maxResponseBytes);
      }
      message = JSON.parse(text) as unknown;
    } catch (error) {
      const responseError = asPublicShareError(error);
      this.fail(responseError);
      this.close(responseError);
      return;
    }

    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "client_connected"
    ) {
      if (!this.readySettled) {
        this.readySettled = true;
        if (this.connectTimeout) {
          clearTimeout(this.connectTimeout);
          this.connectTimeout = null;
        }
        this.readyResolve();
      }
      return;
    }

    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "response"
    ) {
      const response = message as RelayResponse;
      if (
        typeof response.id !== "string" ||
        response.id.length > PUBLIC_SHARE_RELAY_HEADER_NAME_MAX_CHARS ||
        !Number.isInteger(response.status) ||
        response.status < 100 ||
        response.status > 599 ||
        !hasBoundedRelayResponseHeaders(response.headers)
      ) {
        const error = new Error("Relay returned an invalid response");
        this.fail(error);
        this.close(error);
        return;
      }
      if (!this.pending || response.id !== this.pending.id) return;
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timeout);
      pending.resolve(response);
    }
  }

  private fail(error: Error): void {
    if (!this.readySettled) {
      this.readySettled = true;
      if (this.connectTimeout) {
        clearTimeout(this.connectTimeout);
        this.connectTimeout = null;
      }
      this.readyReject(error);
    }
    if (this.pending) {
      const pending = this.pending;
      this.pending = undefined;
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private failTerminal(error: Error): void {
    this.terminalError ??= error;
    this.fail(this.terminalError);
  }
}

export async function fetchPublicShareRelayResponse({
  path,
  relayUrl,
  relayUsername,
  signal,
  maxResponseBytes,
}: PublicShareRelayRequestOptions): Promise<RelayResponse> {
  const connection = new PublicShareRelayConnection(
    relayUrl,
    relayUsername,
    signal,
  );
  try {
    return await connection.request(path, maxResponseBytes);
  } finally {
    connection.close();
  }
}
