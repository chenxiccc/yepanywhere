import {
  RELAY_MUX_PROTOCOL_VERSION,
  type RelayMuxClosedReason,
  type RelayMuxDataFrame,
  type RelayMuxErrorReason,
  RelayMuxFrameError,
  decodeRelayMuxDataFrame,
  encodeRelayMuxDataFrame,
  isRelayMuxCircuitId,
  isRelayMuxClose,
  isRelayMuxOpen,
} from "@yep-anywhere/shared";
import type { Logger } from "pino";
import type { RawData, WebSocket } from "ws";
import type { RelayConfig } from "./config.js";
import type { ConnectionManager, RelayClientEndpoint } from "./connections.js";
import type { RelayTelemetryRecorder } from "./telemetry.js";

const POLICY_CLOSE_CODE = 1008;
const NORMAL_CLOSE_CODE = 1000;
const DRAIN_RETRY_MS = 10;
const RATE_WINDOW_MS = 60_000;
const MAX_INVALID_MESSAGES = 3;

interface QueuedFrame {
  bytes: Buffer;
}

interface MuxCircuit {
  endpoint: RelayClientEndpoint;
  id: number;
  queuedBytes: number;
  queue: QueuedFrame[];
  username: string;
}

export interface RelayMuxStatus {
  physicalSockets: number;
  liveCircuits: number;
  openedTotal: number;
  errorsByReason: Record<RelayMuxErrorReason, number>;
  closedByReason: Record<RelayMuxClosedReason, number>;
}

interface MuxHandlerHooks {
  onProtocolAccepted?: (ws: WebSocket) => void;
  onServerClaimed?: (ws: WebSocket) => void;
}

function rawDataToBuffer(data: RawData): Buffer {
  if (data instanceof Buffer) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(new Uint8Array(data));
}

function emptyErrorCounters(): Record<RelayMuxErrorReason, number> {
  return {
    circuit_limit: 0,
    invalid_request: 0,
    rate_limited: 0,
    server_offline: 0,
    unknown_username: 0,
  };
}

function emptyCloseCounters(): Record<RelayMuxClosedReason, number> {
  return {
    client_closed: 0,
    relay_closed: 0,
    server_closed: 0,
  };
}

class RelayMuxCoordinator {
  private readonly sessions = new Set<RelayMuxSession>();
  private readonly circuitsByIp = new Map<string, number>();
  private readonly ipAttempts = new Map<string, number[]>();
  private readonly ipUsernameAttempts = new Map<string, number[]>();
  private openedTotal = 0;
  private readonly errorsByReason = emptyErrorCounters();
  private readonly closedByReason = emptyCloseCounters();

  constructor(
    private readonly connectionManager: ConnectionManager,
    private readonly config: RelayConfig,
    private readonly logger: Logger,
    private readonly telemetry: RelayTelemetryRecorder,
    private readonly hooks: MuxHandlerHooks,
  ) {}

  open(ws: WebSocket, clientIp: string): RelayMuxSession {
    const session = new RelayMuxSession(
      ws,
      clientIp,
      this,
      this.connectionManager,
      this.config,
      this.logger,
      this.telemetry,
      this.hooks,
    );
    this.sessions.add(session);
    this.telemetry.record({ event: "mux_socket_opened", clientIp });
    return session;
  }

  closeSession(session: RelayMuxSession): void {
    this.sessions.delete(session);
  }

  canOpen(
    session: RelayMuxSession,
    username: string,
  ): RelayMuxErrorReason | null {
    const now = Date.now();
    this.pruneAttempts(now);
    if (session.circuitCount >= this.config.muxMaxCircuitsPerSocket) {
      return "circuit_limit";
    }
    if (
      (this.circuitsByIp.get(session.clientIp) ?? 0) >=
      this.config.muxMaxCircuitsPerIp
    ) {
      return "circuit_limit";
    }
    if (
      !this.recordBoundedAttempt(
        session.openAttempts,
        now,
        this.config.muxOpenAttemptsPerMinutePerSocket,
      )
    ) {
      return "rate_limited";
    }

    const ipAttempts = this.getAttempts(this.ipAttempts, session.clientIp);
    if (
      !this.recordBoundedAttempt(
        ipAttempts,
        now,
        this.config.muxOpenAttemptsPerMinutePerIp,
      )
    ) {
      return "rate_limited";
    }

    const targetKey = `${session.clientIp}\0${username}`;
    const targetAttempts = this.getAttempts(this.ipUsernameAttempts, targetKey);
    if (
      !this.recordBoundedAttempt(
        targetAttempts,
        now,
        this.config.muxOpenAttemptsPerMinutePerIpUsername,
      )
    ) {
      return "rate_limited";
    }
    return null;
  }

  circuitOpened(clientIp: string): void {
    this.openedTotal += 1;
    this.circuitsByIp.set(clientIp, (this.circuitsByIp.get(clientIp) ?? 0) + 1);
  }

  circuitClosed(clientIp: string, reason: RelayMuxClosedReason): void {
    this.closedByReason[reason] += 1;
    const remaining = (this.circuitsByIp.get(clientIp) ?? 1) - 1;
    if (remaining > 0) {
      this.circuitsByIp.set(clientIp, remaining);
    } else {
      this.circuitsByIp.delete(clientIp);
    }
  }

  circuitError(reason: RelayMuxErrorReason): void {
    this.errorsByReason[reason] += 1;
  }

  getStatus(): RelayMuxStatus {
    return {
      physicalSockets: this.sessions.size,
      liveCircuits: Array.from(this.circuitsByIp.values()).reduce(
        (sum, count) => sum + count,
        0,
      ),
      openedTotal: this.openedTotal,
      errorsByReason: { ...this.errorsByReason },
      closedByReason: { ...this.closedByReason },
    };
  }

  private getAttempts(map: Map<string, number[]>, key: string): number[] {
    let attempts = map.get(key);
    if (!attempts) {
      attempts = [];
      map.set(key, attempts);
    }
    return attempts;
  }

  private recordBoundedAttempt(
    attempts: number[],
    now: number,
    limit: number,
  ): boolean {
    attempts.push(now);
    return attempts.length <= limit;
  }

  private pruneAttempts(now: number): void {
    const cutoff = now - RATE_WINDOW_MS;
    for (const map of [this.ipAttempts, this.ipUsernameAttempts]) {
      for (const [key, attempts] of map) {
        while ((attempts[0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
          attempts.shift();
        }
        if (attempts.length === 0) map.delete(key);
      }
    }
    for (const session of this.sessions) {
      while ((session.openAttempts[0] ?? Number.POSITIVE_INFINITY) <= cutoff) {
        session.openAttempts.shift();
      }
    }
  }
}

class RelayMuxSession {
  readonly openAttempts: number[] = [];
  private readonly circuits = new Map<number, MuxCircuit>();
  private circuitOrder: number[] = [];
  private drainCursor = 0;
  private queuedBytes = 0;
  private invalidMessages = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private drainImmediate: ReturnType<typeof setImmediate> | null = null;
  private drainTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private protocolAccepted = false;

  constructor(
    private readonly ws: WebSocket,
    readonly clientIp: string,
    private readonly coordinator: RelayMuxCoordinator,
    private readonly connectionManager: ConnectionManager,
    private readonly config: RelayConfig,
    private readonly logger: Logger,
    private readonly telemetry: RelayTelemetryRecorder,
    private readonly hooks: MuxHandlerHooks,
  ) {
    this.sendControl({
      type: "mux_ready",
      protocolVersion: RELAY_MUX_PROTOCOL_VERSION,
      maxCircuits: config.muxMaxCircuitsPerSocket,
      maxFrameBytes: config.muxMaxFrameBytes,
    });
    this.armIdleTimer();
  }

  get circuitCount(): number {
    return this.circuits.size;
  }

  onMessage(data: RawData, isBinary: boolean): void {
    if (this.closed) return;
    if (isBinary) {
      this.handleData(rawDataToBuffer(data));
      return;
    }

    let message: unknown;
    try {
      message = JSON.parse(rawDataToBuffer(data).toString("utf8"));
    } catch {
      this.recordInvalid();
      return;
    }

    if (isRelayMuxOpen(message)) {
      this.openCircuit(message.circuitId, message.username, message.channel);
      return;
    }
    if (isRelayMuxClose(message)) {
      if (!this.circuits.has(message.circuitId)) {
        this.sendError(message.circuitId, "invalid_request");
        this.recordInvalid();
        return;
      }
      this.closeCircuit(message.circuitId, "client_closed", true, true);
      return;
    }

    const candidate = message as { circuitId?: unknown };
    if (isRelayMuxCircuitId(candidate?.circuitId)) {
      this.sendError(candidate.circuitId, "invalid_request");
    }
    this.recordInvalid();
  }

  onClose(code: number, reason: Buffer): void {
    if (this.closed) return;
    this.closed = true;
    this.clearTimers();
    for (const circuitId of [...this.circuits.keys()]) {
      this.closeCircuit(circuitId, "relay_closed", false, true);
    }
    this.coordinator.closeSession(this);
    this.telemetry.record({
      event: "mux_socket_closed",
      clientIp: this.clientIp,
      closeCode: code,
      closeReason: reason.toString("utf8"),
    });
  }

  onError(error: Error): void {
    this.logger.error({ clientIp: this.clientIp, error }, "Mux socket error");
  }

  private openCircuit(
    circuitId: number,
    username: string,
    channel: "app" | "speech",
  ): void {
    if (this.circuits.has(circuitId)) {
      this.sendError(circuitId, "invalid_request", username);
      return;
    }
    const refusal = this.coordinator.canOpen(this, username);
    if (refusal) {
      this.sendError(circuitId, refusal, username);
      return;
    }

    const endpointKey = {};
    const endpoint: RelayClientEndpoint = {
      key: endpointKey,
      send: (data, isBinary) =>
        this.queueServerFrame(circuitId, data, isBinary),
      close: () => this.closeCircuit(circuitId, "server_closed", true, false),
    };
    const result = this.connectionManager.connectClientEndpoint(
      endpoint,
      username,
      channel,
    );
    if (result.status !== "connected") {
      this.sendError(circuitId, result.status, username);
      return;
    }

    const circuit: MuxCircuit = {
      endpoint,
      id: circuitId,
      queuedBytes: 0,
      queue: [],
      username,
    };
    this.circuits.set(circuitId, circuit);
    this.circuitOrder.push(circuitId);
    this.coordinator.circuitOpened(this.clientIp);
    this.clearIdleTimer();
    this.hooks.onServerClaimed?.(result.serverWs);
    if (!this.protocolAccepted) {
      this.protocolAccepted = true;
      this.hooks.onProtocolAccepted?.(this.ws);
    }

    this.sendControl({ type: "mux_opened", circuitId });
    this.telemetry.record({
      event: "client_connect_success",
      username,
      installId: result.server?.installId,
      appVersion: result.server?.appVersion,
      resumeProtocolVersion: result.server?.resumeProtocolVersion,
      renderProtocolVersion: result.server?.renderProtocolVersion,
      remoteCompatibilityLevel: result.server?.remoteCompatibilityLevel,
      capabilities: result.server?.capabilities
        ? [...result.server.capabilities]
        : undefined,
    });
    this.telemetry.record({
      event: "mux_circuit_opened",
      clientIp: this.clientIp,
      circuitId,
      username,
    });
  }

  private handleData(buffer: Buffer): void {
    let frame: RelayMuxDataFrame;
    try {
      frame = decodeRelayMuxDataFrame(buffer);
    } catch (error) {
      if (
        error instanceof RelayMuxFrameError &&
        isRelayMuxCircuitId(error.circuitId)
      ) {
        this.sendError(error.circuitId, "invalid_request");
      }
      this.recordInvalid();
      return;
    }

    const circuit = this.circuits.get(frame.circuitId);
    if (!circuit) {
      this.sendError(frame.circuitId, "invalid_request");
      this.recordInvalid();
      return;
    }
    if (frame.payload.byteLength > this.config.muxMaxFrameBytes) {
      this.closeCircuit(frame.circuitId, "relay_closed", true, true);
      return;
    }

    this.connectionManager.forward(
      circuit.endpoint.key,
      Buffer.from(
        frame.payload.buffer,
        frame.payload.byteOffset,
        frame.payload.byteLength,
      ),
      frame.isBinary,
    );
  }

  private queueServerFrame(
    circuitId: number,
    data: Buffer,
    isBinary: boolean,
  ): void {
    const circuit = this.circuits.get(circuitId);
    if (!circuit || this.closed) return;
    if (data.byteLength > this.config.muxMaxFrameBytes) {
      this.closeCircuit(circuitId, "relay_closed", true, true);
      return;
    }

    const encoded = Buffer.from(
      encodeRelayMuxDataFrame(circuitId, data, isBinary),
    );
    if (
      circuit.queuedBytes + encoded.byteLength >
        this.config.muxMaxQueuedBytesPerCircuit ||
      this.queuedBytes + encoded.byteLength >
        this.config.muxMaxQueuedBytesPerSocket
    ) {
      this.closeCircuit(circuitId, "relay_closed", true, true);
      return;
    }

    circuit.queue.push({ bytes: encoded });
    circuit.queuedBytes += encoded.byteLength;
    this.queuedBytes += encoded.byteLength;
    this.scheduleDrain(false);
  }

  private scheduleDrain(delayed: boolean): void {
    if (this.closed || this.drainImmediate || this.drainTimer) return;
    if (delayed) {
      this.drainTimer = setTimeout(() => {
        this.drainTimer = null;
        this.drain();
      }, DRAIN_RETRY_MS);
      this.drainTimer.unref?.();
      return;
    }
    this.drainImmediate = setImmediate(() => {
      this.drainImmediate = null;
      this.drain();
    });
    this.drainImmediate.unref?.();
  }

  private drain(): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    while (
      this.queuedBytes > 0 &&
      this.ws.bufferedAmount <= this.config.muxBufferedAmountHighWaterBytes
    ) {
      const circuit = this.nextQueuedCircuit();
      const queued = circuit?.queue.shift();
      if (!circuit || !queued) break;
      circuit.queuedBytes -= queued.bytes.byteLength;
      this.queuedBytes -= queued.bytes.byteLength;
      try {
        this.ws.send(queued.bytes, { binary: true });
      } catch {
        this.ws.close(POLICY_CLOSE_CODE, "Mux send failed");
        return;
      }
    }
    if (this.queuedBytes > 0) {
      this.scheduleDrain(true);
    }
  }

  private nextQueuedCircuit(): MuxCircuit | null {
    if (this.circuitOrder.length === 0) return null;
    for (let offset = 0; offset < this.circuitOrder.length; offset += 1) {
      const index = (this.drainCursor + offset) % this.circuitOrder.length;
      const circuitId = this.circuitOrder[index];
      const circuit =
        circuitId === undefined ? undefined : this.circuits.get(circuitId);
      if (circuit && circuit.queue.length > 0) {
        this.drainCursor = (index + 1) % this.circuitOrder.length;
        return circuit;
      }
    }
    return null;
  }

  private closeCircuit(
    circuitId: number,
    reason: RelayMuxClosedReason,
    notifyClient: boolean,
    closeServer: boolean,
  ): void {
    const circuit = this.circuits.get(circuitId);
    if (!circuit) return;
    this.circuits.delete(circuitId);
    this.circuitOrder = this.circuitOrder.filter((id) => id !== circuitId);
    this.queuedBytes -= circuit.queuedBytes;
    circuit.queue.length = 0;
    circuit.queuedBytes = 0;
    if (closeServer) {
      const result = this.connectionManager.handleClientEndpointClose(
        circuit.endpoint.key,
      );
      if (result.kind === "pair_disconnected") {
        this.telemetry.record({
          event: "pair_disconnected",
          username: circuit.username,
          initiator: "client",
          closeCode: NORMAL_CLOSE_CODE,
          closeReason: reason,
        });
      }
    }
    this.coordinator.circuitClosed(this.clientIp, reason);
    if (notifyClient && !this.closed) {
      this.sendControl({ type: "mux_closed", circuitId, reason });
    }
    this.telemetry.record({
      event: "mux_circuit_closed",
      clientIp: this.clientIp,
      circuitId,
      username: circuit.username,
      reason,
    });
    if (this.circuits.size === 0 && !this.closed) {
      this.armIdleTimer();
    }
  }

  private sendError(
    circuitId: number,
    reason: RelayMuxErrorReason,
    username?: string,
  ): void {
    this.coordinator.circuitError(reason);
    this.sendControl({ type: "mux_error", circuitId, reason });
    this.telemetry.record({
      event: "mux_circuit_error",
      clientIp: this.clientIp,
      circuitId,
      username,
      reason,
    });
    if (reason === "server_offline" || reason === "unknown_username") {
      this.telemetry.record({
        event: "client_connect_error",
        username: username ?? "unknown",
        reason,
      });
    }
  }

  private sendControl(message: object): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return;
    try {
      this.ws.send(JSON.stringify(message), { binary: false });
    } catch {
      this.ws.close(POLICY_CLOSE_CODE, "Mux control send failed");
    }
  }

  private recordInvalid(): void {
    this.invalidMessages += 1;
    if (this.invalidMessages >= MAX_INVALID_MESSAGES) {
      this.ws.close(POLICY_CLOSE_CODE, "Repeated invalid mux messages");
    }
  }

  private armIdleTimer(): void {
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (this.circuits.size === 0) {
        this.ws.close(POLICY_CLOSE_CODE, "Idle mux connection");
      }
    }, this.config.muxIdleTimeoutMs);
    this.idleTimer.unref?.();
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearIdleTimer();
    if (this.drainImmediate) {
      clearImmediate(this.drainImmediate);
      this.drainImmediate = null;
    }
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
  }
}

export function createMuxHandler(
  connectionManager: ConnectionManager,
  config: RelayConfig,
  logger: Logger,
  telemetry: RelayTelemetryRecorder,
  hooks: MuxHandlerHooks = {},
) {
  const coordinator = new RelayMuxCoordinator(
    connectionManager,
    config,
    logger,
    telemetry,
    hooks,
  );
  const sessions = new WeakMap<WebSocket, RelayMuxSession>();

  return {
    onOpen(ws: WebSocket, clientIp: string): void {
      sessions.set(ws, coordinator.open(ws, clientIp));
    },
    onMessage(ws: WebSocket, data: RawData, isBinary: boolean): void {
      sessions.get(ws)?.onMessage(data, isBinary);
    },
    onClose(ws: WebSocket, code: number, reason: Buffer): void {
      sessions.get(ws)?.onClose(code, reason);
      sessions.delete(ws);
    },
    onError(ws: WebSocket, error: Error): void {
      sessions.get(ws)?.onError(error);
    },
    getStatus(): RelayMuxStatus {
      return coordinator.getStatus();
    },
  };
}
