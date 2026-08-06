import {
  DEFAULT_RELAY_CHANNEL,
  SPEECH_RELAY_CHANNEL,
  type RelayChannel,
} from "./relay-protocol.js";

export const RELAY_CLIENT_MUX_V1_CAPABILITY = "client-mux-v1";
export const RELAY_MUX_PROTOCOL_VERSION = 1;
export const RELAY_MUX_HEADER_BYTES = 6;
export const RELAY_MUX_BINARY_FLAG = 1;

export interface RelayMuxReady {
  type: "mux_ready";
  protocolVersion: 1;
  maxCircuits: number;
  maxFrameBytes: number;
}

export interface RelayMuxOpen {
  type: "mux_open";
  circuitId: number;
  username: string;
  channel: RelayChannel;
}

export interface RelayMuxOpened {
  type: "mux_opened";
  circuitId: number;
}

export type RelayMuxErrorReason =
  | "unknown_username"
  | "server_offline"
  | "circuit_limit"
  | "rate_limited"
  | "invalid_request";

export interface RelayMuxError {
  type: "mux_error";
  circuitId: number;
  reason: RelayMuxErrorReason;
}

export interface RelayMuxClose {
  type: "mux_close";
  circuitId: number;
}

export type RelayMuxClosedReason =
  | "client_closed"
  | "server_closed"
  | "relay_closed";

export interface RelayMuxClosed {
  type: "mux_closed";
  circuitId: number;
  reason: RelayMuxClosedReason;
}

export type RelayMuxClientControl = RelayMuxOpen | RelayMuxClose;
export type RelayMuxServerControl =
  | RelayMuxReady
  | RelayMuxOpened
  | RelayMuxError
  | RelayMuxClosed;

export interface RelayMuxDataFrame {
  circuitId: number;
  isBinary: boolean;
  payload: Uint8Array;
}

export class RelayMuxFrameError extends Error {
  constructor(
    message: string,
    readonly circuitId?: number,
  ) {
    super(message);
    this.name = "RelayMuxFrameError";
  }
}

export function isRelayMuxCircuitId(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= 0xffff_ffff
  );
}

function isRelayChannel(value: unknown): value is RelayChannel {
  return value === DEFAULT_RELAY_CHANNEL || value === SPEECH_RELAY_CHANNEL;
}

export function isRelayMuxReady(value: unknown): value is RelayMuxReady {
  const message = value as Partial<RelayMuxReady>;
  return (
    typeof value === "object" &&
    value !== null &&
    message.type === "mux_ready" &&
    message.protocolVersion === RELAY_MUX_PROTOCOL_VERSION &&
    typeof message.maxCircuits === "number" &&
    Number.isSafeInteger(message.maxCircuits) &&
    message.maxCircuits > 0 &&
    typeof message.maxFrameBytes === "number" &&
    Number.isSafeInteger(message.maxFrameBytes) &&
    message.maxFrameBytes > 0
  );
}

export function isRelayMuxOpen(value: unknown): value is RelayMuxOpen {
  const message = value as Partial<RelayMuxOpen>;
  return (
    typeof value === "object" &&
    value !== null &&
    message.type === "mux_open" &&
    isRelayMuxCircuitId(message.circuitId) &&
    typeof message.username === "string" &&
    isRelayChannel(message.channel)
  );
}

export function isRelayMuxOpened(value: unknown): value is RelayMuxOpened {
  const message = value as Partial<RelayMuxOpened>;
  return (
    typeof value === "object" &&
    value !== null &&
    message.type === "mux_opened" &&
    isRelayMuxCircuitId(message.circuitId)
  );
}

export function isRelayMuxError(value: unknown): value is RelayMuxError {
  const message = value as Partial<RelayMuxError>;
  return (
    typeof value === "object" &&
    value !== null &&
    message.type === "mux_error" &&
    isRelayMuxCircuitId(message.circuitId) &&
    (message.reason === "unknown_username" ||
      message.reason === "server_offline" ||
      message.reason === "circuit_limit" ||
      message.reason === "rate_limited" ||
      message.reason === "invalid_request")
  );
}

export function isRelayMuxClose(value: unknown): value is RelayMuxClose {
  const message = value as Partial<RelayMuxClose>;
  return (
    typeof value === "object" &&
    value !== null &&
    message.type === "mux_close" &&
    isRelayMuxCircuitId(message.circuitId)
  );
}

export function isRelayMuxClosed(value: unknown): value is RelayMuxClosed {
  const message = value as Partial<RelayMuxClosed>;
  return (
    typeof value === "object" &&
    value !== null &&
    message.type === "mux_closed" &&
    isRelayMuxCircuitId(message.circuitId) &&
    (message.reason === "client_closed" ||
      message.reason === "server_closed" ||
      message.reason === "relay_closed")
  );
}

export function encodeRelayMuxDataFrame(
  circuitId: number,
  payload: Uint8Array,
  isBinary: boolean,
): Uint8Array {
  if (!isRelayMuxCircuitId(circuitId)) {
    throw new RelayMuxFrameError("Invalid relay mux circuit id");
  }

  const frame = new Uint8Array(RELAY_MUX_HEADER_BYTES + payload.byteLength);
  frame[0] = RELAY_MUX_PROTOCOL_VERSION;
  frame[1] = isBinary ? RELAY_MUX_BINARY_FLAG : 0;
  const view = new DataView(frame.buffer);
  view.setUint32(2, circuitId, false);
  frame.set(payload, RELAY_MUX_HEADER_BYTES);
  return frame;
}

export function decodeRelayMuxDataFrame(
  input: ArrayBuffer | Uint8Array,
): RelayMuxDataFrame {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.byteLength < RELAY_MUX_HEADER_BYTES) {
    throw new RelayMuxFrameError("Relay mux data frame is too short");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const circuitId = view.getUint32(2, false);
  if (bytes[0] !== RELAY_MUX_PROTOCOL_VERSION) {
    throw new RelayMuxFrameError(
      "Unsupported relay mux frame version",
      circuitId || undefined,
    );
  }
  const flags = bytes[1] ?? 0;
  if ((flags & ~RELAY_MUX_BINARY_FLAG) !== 0) {
    throw new RelayMuxFrameError(
      "Invalid relay mux frame flags",
      circuitId || undefined,
    );
  }
  if (!isRelayMuxCircuitId(circuitId)) {
    throw new RelayMuxFrameError("Invalid relay mux circuit id");
  }

  return {
    circuitId,
    isBinary: (flags & RELAY_MUX_BINARY_FLAG) !== 0,
    payload: bytes.subarray(RELAY_MUX_HEADER_BYTES),
  };
}
