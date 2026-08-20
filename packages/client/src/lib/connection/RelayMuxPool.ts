import {
  DEFAULT_RELAY_CHANNEL,
  RELAY_CLIENT_MUX_V1_CAPABILITY,
  type RelayChannel,
  type RelayMuxErrorReason,
  decodeRelayMuxDataFrame,
  encodeRelayMuxDataFrame,
  isRelayMuxClosed,
  isRelayMuxError,
  isRelayMuxOpened,
  isRelayMuxReady,
} from "@yep-anywhere/shared";
import type { SavedHost } from "../hostStorage";
import {
  openRelayClientSocket,
  type OpenRelayClientSocketOptions,
} from "./RelayClientSocket";
import { relayEndpoints, type RelayEndpoints } from "./relayEndpoints";
import type { RelaySocketFactory } from "./SecureConnection";
import type { SecureConnectionSocket } from "./SecureConnectionSocket";

const DISCOVERY_TIMEOUT_MS = 2000;
const MUX_READY_TIMEOUT_MS = 5000;
const MUX_OPEN_TIMEOUT_MS = 30_000;
const CLIENT_QUEUE_BYTES_PER_CIRCUIT = 2 * 1024 * 1024;
const CLIENT_QUEUE_BYTES_PER_SOCKET = 8 * 1024 * 1024;
const CLIENT_BUFFERED_AMOUNT_HIGH_WATER = 1024 * 1024;
const DRAIN_RETRY_MS = 10;
const MAX_MUX_HOSTS_PER_GROUP = 5;
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

interface RelayHealthResponse {
  relayCapabilities?: unknown;
}

interface PendingCircuit {
  reject(error: Error): void;
  resolve(socket: RelayMuxCircuitSocket): void;
  socket: RelayMuxCircuitSocket;
  timeout: ReturnType<typeof setTimeout>;
}

interface ClientQueuedFrame {
  bytes: Uint8Array;
  circuitId: number;
}

export interface RelayMuxPoolOptions {
  createWebSocket?: (url: string) => WebSocket;
  fetch?: typeof fetch;
  openLegacySocket?: (
    options: OpenRelayClientSocketOptions,
  ) => Promise<SecureConnectionSocket>;
}

export class RelayMuxCircuitOpenError extends Error {
  constructor(readonly reason: RelayMuxErrorReason) {
    super(reason);
    this.name = "RelayMuxCircuitOpenError";
  }
}

function abortError(): Error {
  return new DOMException("Relay connection aborted", "AbortError");
}

function socketPayloadBytes(data: string | ArrayBuffer | ArrayBufferView): {
  bytes: Uint8Array;
  isBinary: boolean;
} {
  if (typeof data === "string") {
    return { bytes: new TextEncoder().encode(data), isBinary: false };
  }
  if (data instanceof ArrayBuffer) {
    return { bytes: new Uint8Array(data), isBinary: true };
  }
  return {
    bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    isBinary: true,
  };
}

class RelayMuxCircuitSocket implements SecureConnectionSocket {
  binaryType: BinaryType = "arraybuffer";
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  private state = WS_CONNECTING;

  constructor(
    private readonly physical: RelayMuxPhysicalConnection,
    readonly circuitId: number,
  ) {}

  get bufferedAmount(): number {
    return this.physical.bufferedAmount;
  }

  get readyState(): number {
    return this.state;
  }

  markOpen(): void {
    if (this.state === WS_CONNECTING) this.state = WS_OPEN;
  }

  receive(payload: Uint8Array, isBinary: boolean): void {
    if (this.state !== WS_OPEN) return;
    const data = isBinary
      ? payload.buffer.slice(
          payload.byteOffset,
          payload.byteOffset + payload.byteLength,
        )
      : new TextDecoder().decode(payload);
    this.onmessage?.(new MessageEvent("message", { data }));
  }

  remoteClose(code: number, reason: string): void {
    if (this.state === WS_CLOSED) return;
    this.state = WS_CLOSED;
    this.onclose?.(
      new CloseEvent("close", { code, reason, wasClean: code === 1000 }),
    );
  }

  fail(message: string): void {
    if (this.state === WS_CLOSED) return;
    this.onerror?.(new Event("error"));
    this.physical.closeCircuit(this.circuitId, message);
  }

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.state !== WS_OPEN) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    const payload = socketPayloadBytes(data);
    this.physical.sendCircuitData(
      this.circuitId,
      payload.bytes,
      payload.isBinary,
    );
  }

  close(code = 1000, reason = ""): void {
    if (this.state === WS_CLOSING || this.state === WS_CLOSED) return;
    this.state = WS_CLOSING;
    this.physical.requestCircuitClose(this.circuitId, code, reason);
  }
}

class RelayMuxPhysicalConnection {
  private readonly circuits = new Map<number, RelayMuxCircuitSocket>();
  private readonly pending = new Map<number, PendingCircuit>();
  private readonly queues = new Map<number, ClientQueuedFrame[]>();
  private readonly queuedBytesByCircuit = new Map<number, number>();
  private queuedBytes = 0;
  private circuitOrder: number[] = [];
  private drainCursor = 0;
  private drainScheduled = false;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private nextCircuitId = 1;
  private maxFrameBytes = 0;
  private maxCircuits = 0;
  private closed = false;

  private constructor(
    private readonly ws: WebSocket,
    private readonly onPhysicalClose: () => void,
  ) {}

  static connect(
    url: string,
    createWebSocket: (url: string) => WebSocket,
    onPhysicalClose: () => void,
  ): Promise<RelayMuxPhysicalConnection> {
    return new Promise((resolve, reject) => {
      const ws = createWebSocket(url);
      ws.binaryType = "arraybuffer";
      const physical = new RelayMuxPhysicalConnection(ws, onPhysicalClose);
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        ws.close();
        reject(new Error("Relay mux ready timeout"));
      }, MUX_READY_TIMEOUT_MS);

      ws.onmessage = (event) => {
        if (!settled && typeof event.data === "string") {
          try {
            const message: unknown = JSON.parse(event.data);
            if (isRelayMuxReady(message)) {
              settled = true;
              clearTimeout(timeout);
              physical.maxCircuits = message.maxCircuits;
              physical.maxFrameBytes = message.maxFrameBytes;
              resolve(physical);
              return;
            }
          } catch {
            // The normal handler below will close malformed mux traffic.
          }
        }
        physical.handleMessage(event);
      };
      ws.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(new Error("Failed to connect to relay mux"));
      };
      ws.onclose = (event) => {
        clearTimeout(timeout);
        physical.handleClose(event);
        if (!settled) {
          settled = true;
          reject(new Error("Relay mux closed before ready"));
        }
      };
    });
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  get isOpen(): boolean {
    return !this.closed && this.ws.readyState === WS_OPEN;
  }

  async openCircuit(
    username: string,
    channel: RelayChannel,
    signal?: AbortSignal,
  ): Promise<SecureConnectionSocket> {
    if (!this.isOpen) throw new Error("Relay mux is not connected");
    if (this.circuits.size + this.pending.size >= this.maxCircuits) {
      throw new RelayMuxCircuitOpenError("circuit_limit");
    }
    const circuitId = this.allocateCircuitId();
    const socket = new RelayMuxCircuitSocket(this, circuitId);

    return new Promise((resolve, reject) => {
      const handleAbort = () => {
        this.pending.delete(circuitId);
        clearTimeout(timeout);
        this.sendControl({ type: "mux_close", circuitId });
        socket.remoteClose(1000, "Relay connection aborted");
        reject(abortError());
      };
      const timeout = setTimeout(() => {
        this.pending.delete(circuitId);
        signal?.removeEventListener("abort", handleAbort);
        this.sendControl({ type: "mux_close", circuitId });
        socket.remoteClose(1006, "Waiting for relay circuit timed out");
        reject(new Error("Waiting for relay circuit timed out"));
      }, MUX_OPEN_TIMEOUT_MS);
      const pending: PendingCircuit = {
        socket,
        timeout,
        resolve: (openedSocket) => {
          signal?.removeEventListener("abort", handleAbort);
          resolve(openedSocket);
        },
        reject: (error) => {
          signal?.removeEventListener("abort", handleAbort);
          reject(error);
        },
      };
      this.pending.set(circuitId, pending);
      if (signal?.aborted) {
        handleAbort();
        return;
      }
      signal?.addEventListener("abort", handleAbort, { once: true });
      this.sendControl({
        type: "mux_open",
        circuitId,
        username,
        channel,
      });
    });
  }

  sendCircuitData(
    circuitId: number,
    payload: Uint8Array,
    isBinary: boolean,
  ): void {
    const circuit = this.circuits.get(circuitId);
    if (!circuit || !this.isOpen) {
      throw new DOMException("WebSocket is not open", "InvalidStateError");
    }
    if (payload.byteLength > this.maxFrameBytes) {
      circuit.fail("Relay mux frame is too large");
      throw new DOMException(
        "Relay mux frame is too large",
        "QuotaExceededError",
      );
    }

    const bytes = encodeRelayMuxDataFrame(circuitId, payload, isBinary);
    const circuitBytes = this.queuedBytesByCircuit.get(circuitId) ?? 0;
    if (
      circuitBytes + bytes.byteLength > CLIENT_QUEUE_BYTES_PER_CIRCUIT ||
      this.queuedBytes + bytes.byteLength > CLIENT_QUEUE_BYTES_PER_SOCKET
    ) {
      circuit.fail("Relay mux queue overflow");
      throw new DOMException("Relay mux queue overflow", "QuotaExceededError");
    }
    let queue = this.queues.get(circuitId);
    if (!queue) {
      queue = [];
      this.queues.set(circuitId, queue);
      this.circuitOrder.push(circuitId);
    }
    queue.push({ bytes, circuitId });
    this.queuedBytesByCircuit.set(circuitId, circuitBytes + bytes.byteLength);
    this.queuedBytes += bytes.byteLength;
    this.scheduleDrain(false);
  }

  requestCircuitClose(circuitId: number, _code: number, _reason: string): void {
    if (!this.circuits.has(circuitId)) return;
    if (!this.isOpen) {
      this.removeCircuit(circuitId, 1006, "Relay mux disconnected");
      return;
    }
    this.sendControl({ type: "mux_close", circuitId });
  }

  closeCircuit(circuitId: number, reason: string): void {
    if (!this.circuits.has(circuitId)) return;
    if (this.isOpen) {
      this.sendControl({ type: "mux_close", circuitId });
    }
    this.removeCircuit(circuitId, 1008, reason);
  }

  close(): void {
    if (this.closed) return;
    this.ws.close(1000, "Mux pool disposed");
  }

  private handleMessage(event: MessageEvent): void {
    if (typeof event.data === "string") {
      let message: unknown;
      try {
        message = JSON.parse(event.data);
      } catch {
        this.ws.close(1008, "Invalid relay mux control");
        return;
      }
      if (isRelayMuxOpened(message)) {
        const pending = this.pending.get(message.circuitId);
        if (!pending) {
          this.sendControl({
            type: "mux_close",
            circuitId: message.circuitId,
          });
          return;
        }
        this.pending.delete(message.circuitId);
        clearTimeout(pending.timeout);
        pending.socket.markOpen();
        this.circuits.set(message.circuitId, pending.socket);
        pending.resolve(pending.socket);
        return;
      }
      if (isRelayMuxError(message)) {
        const pending = this.pending.get(message.circuitId);
        if (!pending) return;
        this.pending.delete(message.circuitId);
        clearTimeout(pending.timeout);
        pending.socket.remoteClose(1008, message.reason);
        pending.reject(new RelayMuxCircuitOpenError(message.reason));
        return;
      }
      if (isRelayMuxClosed(message)) {
        this.removeCircuit(message.circuitId, 1000, message.reason);
        return;
      }
      if (isRelayMuxReady(message)) return;
      this.ws.close(1008, "Unexpected relay mux control");
      return;
    }

    if (!(event.data instanceof ArrayBuffer)) {
      this.ws.close(1008, "Invalid relay mux data");
      return;
    }
    try {
      const frame = decodeRelayMuxDataFrame(event.data);
      if (frame.payload.byteLength > this.maxFrameBytes) {
        this.closeCircuit(frame.circuitId, "Relay mux frame is too large");
        return;
      }
      this.circuits
        .get(frame.circuitId)
        ?.receive(frame.payload, frame.isBinary);
    } catch {
      this.ws.close(1008, "Invalid relay mux data");
    }
  }

  private handleClose(event: CloseEvent): void {
    if (this.closed) return;
    this.closed = true;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.socket.remoteClose(event.code, event.reason);
      pending.reject(new Error(event.reason || "Relay mux disconnected"));
    }
    this.pending.clear();
    for (const circuitId of this.circuits.keys()) {
      this.removeCircuit(
        circuitId,
        event.code || 1006,
        event.reason || "Relay mux disconnected",
      );
    }
    this.onPhysicalClose();
  }

  private removeCircuit(circuitId: number, code: number, reason: string): void {
    const circuit = this.circuits.get(circuitId);
    if (!circuit) return;
    this.circuits.delete(circuitId);
    const circuitBytes = this.queuedBytesByCircuit.get(circuitId) ?? 0;
    this.queuedBytes -= circuitBytes;
    this.queuedBytesByCircuit.delete(circuitId);
    this.queues.delete(circuitId);
    this.circuitOrder = this.circuitOrder.filter((id) => id !== circuitId);
    circuit.remoteClose(code, reason);
  }

  private sendControl(message: object): void {
    if (!this.isOpen) throw new Error("Relay mux is not connected");
    this.ws.send(JSON.stringify(message));
  }

  private allocateCircuitId(): number {
    for (let attempts = 0; attempts < 0xffff_ffff; attempts += 1) {
      const candidate = this.nextCircuitId;
      this.nextCircuitId =
        this.nextCircuitId === 0xffff_ffff ? 1 : this.nextCircuitId + 1;
      if (!this.pending.has(candidate) && !this.circuits.has(candidate)) {
        return candidate;
      }
    }
    throw new Error("Relay mux circuit ids exhausted");
  }

  private scheduleDrain(delayed: boolean): void {
    if (this.closed || this.drainScheduled || this.drainTimer) return;
    if (delayed) {
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        this.drain();
      }, DRAIN_RETRY_MS);
      return;
    }
    this.drainScheduled = true;
    queueMicrotask(() => {
      this.drainScheduled = false;
      this.drain();
    });
  }

  private drain(): void {
    if (!this.isOpen) return;
    while (
      this.queuedBytes > 0 &&
      this.ws.bufferedAmount <= CLIENT_BUFFERED_AMOUNT_HIGH_WATER
    ) {
      const frame = this.nextQueuedFrame();
      if (!frame) break;
      this.ws.send(frame.bytes);
    }
    if (this.queuedBytes > 0) this.scheduleDrain(true);
  }

  private nextQueuedFrame(): ClientQueuedFrame | null {
    if (this.circuitOrder.length === 0) return null;
    for (let offset = 0; offset < this.circuitOrder.length; offset += 1) {
      const index = (this.drainCursor + offset) % this.circuitOrder.length;
      const circuitId = this.circuitOrder[index];
      if (circuitId === undefined) continue;
      const queue = this.queues.get(circuitId);
      if (!queue) continue;
      const frame = queue.shift();
      if (!frame) continue;
      this.drainCursor = (index + 1) % this.circuitOrder.length;
      const remaining =
        (this.queuedBytesByCircuit.get(circuitId) ?? frame.bytes.byteLength) -
        frame.bytes.byteLength;
      this.queuedBytesByCircuit.set(circuitId, remaining);
      this.queuedBytes -= frame.bytes.byteLength;
      if (queue.length === 0) {
        this.queues.delete(circuitId);
        this.circuitOrder = this.circuitOrder.filter((id) => id !== circuitId);
      }
      return frame;
    }
    return null;
  }
}

class RelayMuxGroup {
  private discovery: Promise<boolean> | null = null;
  private physical: RelayMuxPhysicalConnection | null = null;
  private physicalOpening: Promise<RelayMuxPhysicalConnection> | null = null;
  private degraded = false;
  private disposed = false;
  private readonly lifetime = new AbortController();

  constructor(
    private readonly endpoints: RelayEndpoints,
    private readonly options: Required<RelayMuxPoolOptions>,
  ) {}

  async open(
    options: OpenRelayClientSocketOptions,
  ): Promise<SecureConnectionSocket> {
    if (this.disposed) throw abortError();
    const muxAvailable = this.degraded ? false : await this.discover();
    if (this.disposed) throw abortError();
    if (this.degraded || !muxAvailable) {
      return this.options.openLegacySocket(options);
    }

    let physical: RelayMuxPhysicalConnection;
    try {
      physical = await this.ensurePhysical();
    } catch (error) {
      if (
        this.disposed ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      this.degraded = true;
      return this.options.openLegacySocket(options);
    }

    try {
      return await physical.openCircuit(
        options.relayUsername,
        options.channel ?? DEFAULT_RELAY_CHANNEL,
        options.signal,
      );
    } catch (error) {
      if (
        error instanceof RelayMuxCircuitOpenError ||
        (error instanceof DOMException && error.name === "AbortError")
      ) {
        throw error;
      }
      this.degraded = true;
      return this.options.openLegacySocket(options);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.lifetime.abort();
    this.physical?.close();
    this.physical = null;
  }

  private discover(): Promise<boolean> {
    if (this.discovery) return this.discovery;
    this.discovery = this.runDiscovery();
    return this.discovery;
  }

  private async runDiscovery(): Promise<boolean> {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), DISCOVERY_TIMEOUT_MS);
    const abortLifetime = () => timeout.abort();
    this.lifetime.signal.addEventListener("abort", abortLifetime, {
      once: true,
    });
    try {
      const response = await this.options.fetch(this.endpoints.healthUrl, {
        signal: timeout.signal,
      });
      if (!response.ok) return false;
      const body = (await response.json()) as RelayHealthResponse;
      return (
        Array.isArray(body.relayCapabilities) &&
        body.relayCapabilities.includes(RELAY_CLIENT_MUX_V1_CAPABILITY)
      );
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", abortLifetime);
    }
  }

  private ensurePhysical(): Promise<RelayMuxPhysicalConnection> {
    if (this.physical?.isOpen) return Promise.resolve(this.physical);
    if (this.physicalOpening) return this.physicalOpening;

    let opened: RelayMuxPhysicalConnection | null = null;
    const opening = RelayMuxPhysicalConnection.connect(
      this.endpoints.muxUrl,
      this.options.createWebSocket,
      () => {
        if (this.physical === opened) this.physical = null;
      },
    );
    const checkedOpening = opening
      .then((physical) => {
        opened = physical;
        if (this.disposed) {
          physical.close();
          throw abortError();
        }
        this.physical = physical;
        return physical;
      })
      .finally(() => {
        if (this.physicalOpening === checkedOpening) {
          this.physicalOpening = null;
        }
      });
    this.physicalOpening = checkedOpening;
    return checkedOpening;
  }
}

export class RelayMuxSocketPool {
  private readonly eligibleHostIds = new Set<string>();
  private readonly groups = new Map<string, RelayMuxGroup>();
  private readonly endpointsByHostId = new Map<string, RelayEndpoints>();
  private readonly options: Required<RelayMuxPoolOptions>;
  private disposed = false;

  constructor(hosts: readonly SavedHost[], options: RelayMuxPoolOptions = {}) {
    const fetchImpl = options.fetch ?? fetch;
    this.options = {
      createWebSocket: options.createWebSocket ?? ((url) => new WebSocket(url)),
      fetch: (input, init) => fetchImpl(input, init),
      openLegacySocket: options.openLegacySocket ?? openRelayClientSocket,
    };

    const hostsByGroup = new Map<
      string,
      Array<{ endpoints: RelayEndpoints; host: SavedHost }>
    >();
    for (const host of hosts) {
      if (
        host.mode !== "relay" ||
        !host.session ||
        !host.relayUrl ||
        !host.relayUsername
      ) {
        continue;
      }
      const endpoints = relayEndpoints(host.relayUrl);
      if (!endpoints) continue;
      let groupHosts = hostsByGroup.get(endpoints.key);
      if (!groupHosts) {
        groupHosts = [];
        hostsByGroup.set(endpoints.key, groupHosts);
      }
      groupHosts.push({ endpoints, host });
    }

    for (const [key, groupHosts] of hostsByGroup) {
      if (groupHosts.length < 2) continue;
      const selected = groupHosts.slice(0, MAX_MUX_HOSTS_PER_GROUP);
      const endpoints = selected[0]?.endpoints;
      if (!endpoints) continue;
      this.groups.set(key, new RelayMuxGroup(endpoints, this.options));
      for (const { host, endpoints: hostEndpoints } of selected) {
        this.eligibleHostIds.add(host.id);
        this.endpointsByHostId.set(host.id, hostEndpoints);
      }
    }
  }

  createSocketFactory(host: SavedHost): RelaySocketFactory {
    return (options) => this.open(host, options);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const group of this.groups.values()) group.dispose();
    this.groups.clear();
  }

  private open(
    host: SavedHost,
    options: OpenRelayClientSocketOptions,
  ): Promise<SecureConnectionSocket> {
    if (this.disposed) return Promise.reject(abortError());
    if (!this.eligibleHostIds.has(host.id)) {
      return this.options.openLegacySocket(options);
    }
    const endpoints = this.endpointsByHostId.get(host.id);
    const group = endpoints ? this.groups.get(endpoints.key) : undefined;
    return group?.open(options) ?? this.options.openLegacySocket(options);
  }
}
