import type {
  DeviceServerMessage,
  RemoteClientMessage,
  StagedAttachmentRef,
  UploadedFile,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFrameError,
  decodeJsonFrame,
  encodeJsonFrame,
  encodeUploadChunkFrame,
  isBinaryData,
} from "@yep-anywhere/shared";
import { getDesktopAuthToken } from "../../api/plainFetch";
import type { ConnectionManager } from "./ConnectionManager";
import { RelayProtocol } from "./RelayProtocol";
import type {
  Connection,
  SessionSubscriptionOptions,
  StreamHandlers,
  Subscription,
  UploadOptions,
} from "./types";
import { WebSocketCloseError } from "./types";

export interface WebSocketConnectionSocket {
  readyState: number;
  binaryType: BinaryType;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onopen: ((event: Event) => void) | null;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConnectionFactory = (
  url: string,
) => WebSocketConnectionSocket;

export type WebSocketConnectionSocketState =
  | "connecting"
  | "connected"
  | "disconnected";

export interface WebSocketConnectionOptions {
  createWebSocket?: WebSocketConnectionFactory;
  connectionManager?: ConnectionManager;
  onSocketStateChange?: (state: WebSocketConnectionSocketState) => void;
}

/**
 * Connection to yepanywhere server using WebSocket transport.
 *
 * Implements the relay protocol for HTTP-like request/response
 * over a single WebSocket connection. Protocol logic (request correlation,
 * subscriptions, uploads) is delegated to RelayProtocol.
 */
export class WebSocketConnection implements Connection {
  readonly mode = "direct" as const;

  private ws: WebSocketConnectionSocket | null = null;
  private connectionPromise: Promise<void> | null = null;
  private protocol: RelayProtocol;
  private options: WebSocketConnectionOptions;
  private externalOnPong: ((id: string) => void) | undefined;

  constructor(options: WebSocketConnectionOptions = {}) {
    this.options = options;
    this.protocol = new RelayProtocol(
      {
        sendMessage: (msg) => this.send(msg),
        sendUploadChunk: (id, offset, chunk) => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
            throw new Error("WebSocket not connected");
          }
          this.ws.send(encodeUploadChunkFrame(id, offset, chunk));
        },
        ensureConnected: () => this.ensureConnected(),
        isConnected: () => this.ws?.readyState === WebSocket.OPEN,
      },
      {
        logPrefix: "[WebSocketConnection]",
      },
    );
    this.setConnectionManager(options.connectionManager ?? null);
  }

  setConnectionManager(manager: ConnectionManager | null): void {
    this.options.connectionManager = manager ?? undefined;
    this.updateProtocolPongHandler();
    this.protocol.setOnInboundEvent(
      manager
        ? (event) => {
            if (event.eventType === "heartbeat") {
              manager.recordHeartbeat();
            } else {
              manager.recordEvent();
            }
          }
        : undefined,
    );
    this.protocol.setBeginCriticalOperation(
      manager ? (label) => manager.beginCriticalOperation(label) : undefined,
    );
  }

  private getWsUrl(): string {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const base = `${protocol}//${window.location.host}/api/ws`;
    // Pass desktop token as query param since WebSocket can't set custom headers
    const token = getDesktopAuthToken();
    if (token) {
      return `${base}?desktop_token=${encodeURIComponent(token)}`;
    }
    return base;
  }

  async ensureConnected(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.connectionPromise) {
      return this.connectionPromise;
    }

    this.connectionPromise = this.connect();
    try {
      await this.connectionPromise;
    } finally {
      this.connectionPromise = null;
    }
  }

  private connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const wsUrl = this.getWsUrl();
      console.log("[WebSocketConnection] Connecting to", wsUrl);
      this.options.onSocketStateChange?.("connecting");

      const ws = this.options.createWebSocket
        ? this.options.createWebSocket(wsUrl)
        : new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";

      ws.onerror = (event) => {
        console.error("[WebSocketConnection] Error:", event);
      };

      ws.onclose = (event) => {
        console.log("[WebSocketConnection] Closed:", event.code, event.reason);
        this.ws = null;

        const closeError = new WebSocketCloseError(event.code, event.reason);
        this.protocol.rejectAllPending(closeError);
        this.protocol.notifySubscriptionsClosed(closeError);
        this.options.onSocketStateChange?.("disconnected");
        this.options.connectionManager?.handleClose(closeError);
      };

      ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      const timeout = setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          reject(new Error("WebSocket connection timeout"));
        }
      }, 10000);

      ws.onopen = () => {
        clearTimeout(timeout);
        console.log("[WebSocketConnection] Connected");
        this.ws = ws;
        this.options.connectionManager?.markConnected();
        this.options.onSocketStateChange?.("connected");
        resolve();
      };
    });
  }

  /**
   * Handle incoming WebSocket messages.
   * Supports both text frames (JSON) and binary frames (format byte + payload).
   */
  private handleMessage(data: unknown): void {
    let msg: YepMessage;

    if (isBinaryData(data)) {
      try {
        msg = decodeJsonFrame<YepMessage>(data);
      } catch (err) {
        if (err instanceof BinaryFrameError) {
          console.warn(
            `[WebSocketConnection] Binary frame error (${err.code}):`,
            err.message,
          );
        } else {
          console.warn(
            "[WebSocketConnection] Failed to decode binary frame:",
            err,
          );
        }
        return;
      }
    } else if (typeof data === "string") {
      try {
        msg = JSON.parse(data) as YepMessage;
      } catch {
        console.warn("[WebSocketConnection] Failed to parse message:", data);
        return;
      }
    } else {
      console.warn("[WebSocketConnection] Ignoring unknown message type");
      return;
    }

    this.protocol.routeMessage(msg);
  }

  private send(msg: import("@yep-anywhere/shared").RemoteClientMessage): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("WebSocket not connected");
    }
    this.ws.send(encodeJsonFrame(msg));
  }

  async fetch<T>(path: string, init?: RequestInit): Promise<T> {
    return this.protocol.fetch<T>(path, init);
  }

  async fetchBlob(path: string): Promise<Blob> {
    return this.protocol.fetchBlob(path);
  }

  subscribeSession(
    sessionId: string,
    handlers: StreamHandlers,
    lastEventId?: string,
    options?: SessionSubscriptionOptions,
  ): Subscription {
    return this.protocol.subscribeSession(
      sessionId,
      handlers,
      lastEventId,
      options,
    );
  }

  subscribeActivity(handlers: StreamHandlers): Subscription {
    return this.protocol.subscribeActivity(handlers);
  }

  subscribeGlossary(projectId: string, handlers: StreamHandlers): Subscription {
    return this.protocol.subscribeGlossary(projectId, handlers);
  }

  subscribeSessionWatch(
    sessionId: string,
    handlers: StreamHandlers,
    options?: {
      projectId?: string;
      provider?: string;
    },
  ): Subscription {
    return this.protocol.subscribeSessionWatch(sessionId, handlers, options);
  }

  async upload(
    projectId: string,
    sessionId: string,
    file: File,
    options?: UploadOptions,
  ): Promise<UploadedFile> {
    return this.protocol.upload(projectId, sessionId, file, options);
  }

  async uploadStagedAttachment(
    file: File,
    options?: UploadOptions & { batchId?: string },
  ): Promise<StagedAttachmentRef> {
    return this.protocol.uploadStagedAttachment(file, options);
  }

  /**
   * Send a keepalive ping to verify the connection is alive.
   */
  sendPing(id: string): void {
    this.protocol.sendPing(id);
  }

  /**
   * Register a callback for pong responses.
   */
  setOnPong(cb: (id: string) => void): void {
    this.externalOnPong = cb;
    this.updateProtocolPongHandler();
  }

  private updateProtocolPongHandler(): void {
    const manager = this.options.connectionManager;
    const externalOnPong = this.externalOnPong;
    this.protocol.setOnPong(
      manager || externalOnPong
        ? (id) => {
            manager?.receivePong(id);
            externalOnPong?.(id);
          }
        : undefined,
    );
  }

  /**
   * Reconnect the WebSocket. Tears down the current connection and
   * re-establishes it. Used by ConnectionManager's reconnectFn.
   */
  async reconnect(): Promise<void> {
    const reconnectError = new Error("Connection reconnecting");
    this.protocol.rejectAllPending(reconnectError);
    // Force all stream handlers (activity/session) to transition closed so
    // higher-level consumers can re-subscribe on the new socket.
    this.protocol.notifySubscriptionsClosed(reconnectError);
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.connectionPromise = null;
    await this.ensureConnected();
  }

  sendMessage(msg: RemoteClientMessage): void {
    this.send(msg);
  }

  onDeviceMessage(handler: (msg: DeviceServerMessage) => void): () => void {
    return this.protocol.onDeviceMessage(handler);
  }

  close(): void {
    this.protocol.close();

    if (this.ws) {
      this.ws.onclose = null;
      this.ws.onerror = null;
      this.ws.onmessage = null;
      this.ws.onopen = null;
      this.ws.close();
      this.ws = null;
    }
    this.options.onSocketStateChange?.("disconnected");
  }
}
