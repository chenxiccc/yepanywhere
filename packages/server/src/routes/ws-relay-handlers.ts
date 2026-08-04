/**
 * Shared WebSocket relay handler logic.
 *
 * This module contains the core message handling logic used by both:
 * - createWsRelayRoutes (Hono's upgradeWebSocket for direct connections)
 * - createAcceptRelayConnection (raw WebSocket for relay connections)
 *
 * The handlers are parameterized by dependencies and connection state,
 * allowing both entry points to share the same implementation.
 */

import { randomUUID } from "node:crypto";
import type { HttpBindings } from "@hono/node-server";
import type {
  BinaryFormatValue,
  OriginMetadata,
  RelayRequest,
  RelayUploadError,
  RelaySpeechEvent,
  RelaySubscribe,
  RelayStagedUploadStart,
  RelayUnsubscribe,
  RelayUploadChunk,
  RelayUploadEnd,
  RelayUploadStart,
  RemoteClientMessage,
  UrlProjectId,
  YepMessage,
} from "@yep-anywhere/shared";
import {
  BinaryFormat,
  UploadChunkError,
  decodeUploadChunkPayload,
  encodeJsonFrame,
  isUrlProjectId,
  isSrpClientHello,
  isSrpClientProof,
  isSrpSessionResume,
  isSrpSessionResumeInit,
} from "@yep-anywhere/shared";
import type { Hono } from "hono";
import { encryptToBinaryEnvelopeWithCompression } from "../crypto/index.js";
import type { SrpServerSession } from "../crypto/index.js";
import type { DeviceBridgeService } from "../device/DeviceBridgeService.js";
import { getLogger } from "../logging/logger.js";
import { AUTHENTICATED_SRP_TRANSPORT } from "../middleware/authenticated-transport.js";
import { WS_INTERNAL_AUTHENTICATED } from "../middleware/internal-auth.js";
import type { ProjectGlossarySubscriptionManager } from "../projects/projectGlossarySubscriptionManager.js";
import type {
  RemoteAccessService,
  RemoteSessionService,
} from "../remote-access/index.js";
import type {
  BrowserProfileService,
  ConnectedBrowsersService,
} from "../services/index.js";
import type { SecurityClientService } from "../services/SecurityClientService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { SpeechBackendRegistry } from "../services/voice/registry.js";
import {
  createActivitySubscription,
  createSessionSubscription,
} from "../subscriptions.js";
import type { AttachmentStagingService } from "../uploads/AttachmentStagingService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { UploadManager } from "../uploads/manager.js";
import type { EventBus, FocusedSessionWatchManager } from "../watcher/index.js";
import {
  type WsConnectionPolicy,
  isPolicySrpRequired,
} from "./ws-auth-policy.js";
import {
  type SpeechWebSocketSession,
  createSpeechWebSocketSession,
  type SpeechWsData,
} from "./speech.js";
import {
  decodeFrameToParsedMessage,
  routeClientMessageSafely,
} from "./ws-message-router.js";
import {
  cleanupSrpConnectionState,
  createInitialSrpLimiterState,
  handleSrpHello,
  handleSrpProof,
  handleSrpResume,
  handleSrpResumeInit,
} from "./ws-srp-handlers.js";
import {
  hasEstablishedSrpTransport,
  shouldMarkInternalWsAuthenticated,
} from "./ws-transport-auth.js";
import { parseApplicationClientMessage } from "./ws-transport-message-auth.js";

/** Progress report interval in bytes (64KB) */
export const PROGRESS_INTERVAL = 64 * 1024;

/** Connection authentication state */
export type ConnectionAuthState =
  | "unauthenticated" // Waiting for SRP handshake to begin
  | "srp_waiting_proof" // Sent challenge, waiting for proof
  | "authenticated"; // Admitted by trusted policy or SRP complete

interface SrpTokenBucket {
  capacity: number;
  refillPerMs: number;
  tokens: number;
  lastRefillAt: number;
}

interface SrpLimiterState {
  helloBucket: SrpTokenBucket;
  blockedUntil: number;
  failedProofCount: number;
}

interface SrpConnectionLimiterState extends SrpLimiterState {
  handshakeTimeout: ReturnType<typeof setTimeout> | null;
}

/** Per-connection state for secure connections */
export interface ConnectionState {
  /** Process-unique id used to bind audit clients and active socket teardown. */
  connectionId: string;
  /** SRP session during handshake */
  srpSession: SrpServerSession | null;
  /** Derived secretbox key (32 bytes) for encryption */
  sessionKey: Uint8Array | null;
  /** Long-lived base key derived from SRP/session key for resume proofs. */
  baseSessionKey: Uint8Array | null;
  /** Authentication state */
  authState: ConnectionAuthState;
  /** Admission policy for this connection (distinct from SRP transport key state). */
  connectionPolicy: WsConnectionPolicy;
  /**
   * Whether this authenticated connection must use encrypted envelopes.
   * Set for SRP-authenticated connections; false for trusted local cookie auth.
   */
  requiresEncryptedMessages: boolean;
  /** Username if authenticated */
  username: string | null;
  /** Persistent session ID for resumption (set after successful auth) */
  sessionId: string | null;
  /** Transport nonce retained for the lifetime of an established SRP socket. */
  transportNonce: string | null;
  /** Whether this SRP socket used a full password proof or resume proof. */
  authenticationMethod: "srp-full" | "srp-resume" | null;
  /** Whether the client reached this YA server directly or through the relay. */
  transport: "direct" | "relay";
  /** Direct TCP peer address; absent for relay-mediated phone/browser peers. */
  peerAddress: string | null;
  /** Whether client sent binary frames (respond with binary if true) - Phase 0 */
  useBinaryFrames: boolean;
  /** Client's supported binary formats (Phase 3 capabilities) - defaults to [0x01] */
  supportedFormats: Set<BinaryFormatValue>;
  /** Browser profile ID from SRP hello (for session tracking) */
  browserProfileId: string | null;
  /** Origin metadata from SRP hello (for session tracking) */
  originMetadata: OriginMetadata | null;
  /** Pending one-time challenge for session resume (if any) */
  pendingResumeChallenge: {
    nonce: string;
    clientNonce: string;
    sessionId: string;
    username: string;
    issuedAt: number;
  } | null;
  /** SRP rate-limit and handshake timeout state */
  srpLimiter: SrpConnectionLimiterState;
  /** Next sequence number for encrypted messages sent to the peer */
  nextOutboundSeq: number;
  /** Last accepted inbound encrypted sequence from the peer */
  lastInboundSeq: number | null;
  /** One browser-tab registration shared by this socket's activity streams. */
  browserTabConnection: {
    browserProfileId: string;
    connectionId: number;
    activitySubscriptionCount: number;
  } | null;
}

/** Tracks an active upload over WebSocket relay */
export interface RelayUploadState {
  /** Client-provided upload ID */
  clientUploadId: string;
  /** Upload storage backend */
  uploadKind: "session" | "draft-staging";
  /** Server-generated upload ID from UploadManager */
  serverUploadId: string;
  /** Expected total size */
  expectedSize: number;
  /** Bytes received (for offset validation) */
  bytesReceived: number;
  /** Last progress report sent */
  lastProgressReport: number;
  /** Pending chunk write promises (awaited before completing upload) */
  pendingWrites: Promise<void>[];
}

/**
 * Adapter interface for WebSocket send/close operations.
 * Both Hono's WSContext and raw ws.WebSocket can be adapted to this interface.
 * Note: Hono's WSContext.send uses Uint8Array<ArrayBuffer> (not ArrayBufferLike)
 */
export interface WSAdapter {
  send(data: string | ArrayBuffer | Uint8Array<ArrayBuffer>): void;
  close(code?: number, reason?: string): void;
}

/**
 * Encryption-aware send function type.
 * Created per-connection, captures connection state for automatic encryption.
 */
export type SendFn = (msg: YepMessage) => void;

function relayUploadErrorCode(error: unknown): string | undefined {
  if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOSPC") {
    return "DISK_FULL";
  }
  return undefined;
}

function relayUploadError(
  uploadId: string,
  error: string,
  cause: unknown,
): RelayUploadError {
  const code = relayUploadErrorCode(cause);
  return {
    type: "upload_error",
    uploadId,
    error,
    ...(code ? { code } : {}),
  };
}

/**
 * Dependencies for relay handlers.
 */
export interface RelayHandlerDeps {
  /** The main Hono app to route requests through */
  app: Hono<{ Bindings: HttpBindings }>;
  /** Base URL for internal requests (e.g., "http://localhost:3400") */
  baseUrl: string;
  /** Supervisor for subscribing to session events */
  supervisor: Supervisor;
  /** Event bus for subscribing to activity events */
  eventBus: EventBus;
  /** Upload manager for handling file uploads */
  uploadManager: UploadManager;
  /** Attachment staging service for draft-staged uploads */
  attachmentStagingService?: AttachmentStagingService;
  /** Remote access service for SRP authentication (optional for direct, required for relay) */
  remoteAccessService?: RemoteAccessService;
  /** Remote session service for session persistence (optional for direct, required for relay) */
  remoteSessionService?: RemoteSessionService;
  /** Registered-client continuity and security audit service. */
  securityClientService?: SecurityClientService;
  /** Connected browsers service for tracking WS connections (optional) */
  connectedBrowsers?: ConnectedBrowsersService;
  /** Browser profile service for tracking connection origins (optional) */
  browserProfileService?: BrowserProfileService;
  /** Focused session watch manager for per-session targeted file watching (optional) */
  focusedSessionWatchManager?: FocusedSessionWatchManager;
  /** Project glossary path subscriptions and their reference-counted watchers. */
  projectGlossarySubscriptionManager?: ProjectGlossarySubscriptionManager;
  /** Emulator bridge service for Android emulator streaming (optional) */
  deviceBridgeService?: DeviceBridgeService;
  /** Speech backend registry for relayed streaming STT (optional) */
  speechBackendRegistry?: SpeechBackendRegistry;
  /** Server data dir for relayed speech audio retention (optional) */
  dataDir?: string;
  /** Server settings service for relayed speech retention settings (optional) */
  serverSettingsService?: ServerSettingsService;
}

/**
 * Create an initial connection state.
 */
export function createConnectionState(options?: {
  transport?: "direct" | "relay";
  peerAddress?: string | null;
}): ConnectionState {
  return {
    connectionId: randomUUID(),
    srpSession: null,
    sessionKey: null,
    baseSessionKey: null,
    authState: "unauthenticated",
    connectionPolicy: "srp_required",
    requiresEncryptedMessages: false,
    username: null,
    sessionId: null,
    transportNonce: null,
    authenticationMethod: null,
    transport: options?.transport ?? "direct",
    peerAddress: options?.peerAddress ?? null,
    useBinaryFrames: false,
    supportedFormats: new Set([BinaryFormat.JSON]),
    browserProfileId: null,
    originMetadata: null,
    pendingResumeChallenge: null,
    srpLimiter: createInitialSrpLimiterState(),
    nextOutboundSeq: 0,
    lastInboundSeq: null,
    browserTabConnection: null,
  };
}

export function cleanupConnectionState(connState: ConnectionState): void {
  cleanupSrpConnectionState(connState);
}

/**
 * Create an encryption-aware send function for a connection.
 * Automatically encrypts messages when the connection is authenticated with a session key.
 * Uses binary frames when the client has sent binary frames (Phase 0/1 binary protocol).
 * Compresses large payloads when client supports format 0x03 (Phase 3).
 */
export function createSendFn(
  ws: WSAdapter,
  connState: ConnectionState,
): SendFn {
  return (msg: YepMessage) => {
    try {
      if (hasEstablishedSrpTransport(connState)) {
        const seq = connState.nextOutboundSeq;
        connState.nextOutboundSeq += 1;
        const plaintext = JSON.stringify({ seq, msg });

        const supportsCompression = connState.supportedFormats.has(
          BinaryFormat.COMPRESSED_JSON,
        );
        const envelope = encryptToBinaryEnvelopeWithCompression(
          plaintext,
          connState.sessionKey,
          supportsCompression,
        );
        ws.send(envelope);
      } else if (connState.useBinaryFrames) {
        // Client sent binary frames, respond with binary
        ws.send(encodeJsonFrame(msg));
      } else {
        // Text frame fallback (backwards compat)
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      console.warn("[WS Relay] Failed to send message, closing socket:", err);
      try {
        ws.close(1011, "Send failed");
      } catch {
        // Socket already closing/closed
      }
    }
  };
}

/**
 * Handle a RelayRequest by routing it through the Hono app.
 */
export async function handleRequest(
  request: RelayRequest,
  send: SendFn,
  ws: WSAdapter,
  app: Hono<{ Bindings: HttpBindings }>,
  baseUrl: string,
  connState: ConnectionState,
): Promise<void> {
  try {
    const url = new URL(request.path, baseUrl);
    const headers = new Headers(request.headers);
    headers.set("X-Yep-Anywhere", "true");
    headers.set("X-Ws-Relay", "true");
    if (request.body !== undefined) {
      headers.set("Content-Type", "application/json");
    }

    const fetchInit: RequestInit = {
      method: request.method,
      headers,
    };

    if (
      request.body !== undefined &&
      request.method !== "GET" &&
      request.method !== "DELETE"
    ) {
      fetchInit.body = JSON.stringify(request.body);
    }

    const fetchRequest = new Request(url.toString(), fetchInit);
    // Mark requests from authenticated websocket transport as internal auth so
    // cookie middleware does not re-challenge routed API requests.
    let closeAfterResponse = false;
    const afterResponseTasks: Array<() => Promise<void> | void> = [];
    const srpTransport =
      hasEstablishedSrpTransport(connState) &&
      connState.username &&
      connState.sessionId &&
      connState.transportNonce &&
      connState.authenticationMethod
        ? {
            kind: "srp" as const,
            username: connState.username,
            sessionId: connState.sessionId,
            transportNonce: connState.transportNonce,
            authenticationMethod: connState.authenticationMethod,
            transport: connState.transport,
            connectionId: connState.connectionId,
            ...(connState.peerAddress
              ? { peerAddress: connState.peerAddress }
              : {}),
            closeConnection: () => ws.close(4004, "Security client revoked"),
            closeAfterResponse: () => {
              closeAfterResponse = true;
            },
            deferAfterResponse: (task: () => Promise<void> | void) => {
              afterResponseTasks.push(task);
            },
          }
        : null;
    const internalEnv = shouldMarkInternalWsAuthenticated(connState)
      ? {
          [WS_INTERNAL_AUTHENTICATED]: true,
          ...(srpTransport
            ? { [AUTHENTICATED_SRP_TRANSPORT]: srpTransport }
            : {}),
        }
      : {};
    const response = await app.fetch(fetchRequest, internalEnv);

    let body: unknown;
    const contentType = response.headers.get("Content-Type") ?? "";
    if (contentType.includes("application/json")) {
      try {
        body = await response.json();
      } catch {
        body = null;
      }
    } else if (
      contentType.startsWith("image/") ||
      contentType.startsWith("audio/") ||
      contentType.startsWith("video/") ||
      contentType === "application/pdf" ||
      contentType === "application/octet-stream"
    ) {
      // Binary content: read as ArrayBuffer and encode as base64
      const arrayBuffer = await response.arrayBuffer();
      const bytes = new Uint8Array(arrayBuffer);
      const base64 = Buffer.from(bytes).toString("base64");
      body = { _binary: true, data: base64 };
    } else {
      const text = await response.text();
      body = text || null;
    }

    const responseHeaders: Record<string, string> = {};
    for (const [key, value] of response.headers.entries()) {
      if (
        key.toLowerCase().startsWith("x-") ||
        key.toLowerCase() === "content-type" ||
        key.toLowerCase() === "etag" ||
        key.toLowerCase() === "location"
      ) {
        responseHeaders[key] = value;
      }
    }

    send({
      type: "response",
      id: request.id,
      status: response.status,
      headers:
        Object.keys(responseHeaders).length > 0 ? responseHeaders : undefined,
      body,
    });
    for (const task of afterResponseTasks) {
      try {
        await task();
      } catch (error) {
        console.error("[WS Relay] After-response task failed:", error);
      }
    }
    if (closeAfterResponse) {
      ws.close(4004, "Security client revoked");
    }
  } catch (err) {
    console.error("[WS Relay] Request error:", err);
    send({
      type: "response",
      id: request.id,
      status: 500,
      body: { error: "Internal server error" },
    });
  }
}

/**
 * Handle a session subscription.
 * Subscribes to process events, computes augments, and forwards them as RelayEvent messages.
 */
export function handleSessionSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  supervisor: Supervisor,
): void {
  const { subscriptionId, sessionId } = msg;
  const wantsLiveDeltas = msg.wantsLiveDeltas !== false;

  if (!sessionId) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "sessionId required for session channel" },
    });
    return;
  }

  const process = supervisor.getProcessForSession(sessionId);
  if (!process) {
    send({
      type: "response",
      id: subscriptionId,
      status: 404,
      body: { error: "No active process for session" },
    });
    return;
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  const { cleanup } = createSessionSubscription(process, sendEvent, {
    wantsLiveDeltas,
    onError: (err) => {
      console.error("[WS Relay] Error in session subscription:", err);
    },
  });
  const cleanupPromptCacheKeepalive =
    supervisor.registerPromptCacheKeepaliveViewer(process);

  subscriptions.set(subscriptionId, () => {
    cleanupPromptCacheKeepalive();
    cleanup();
  });

  console.log(
    `[WS Relay] Subscribed to session ${sessionId} (${subscriptionId})`,
  );
}

/**
 * Handle an activity subscription.
 * Subscribes to event bus and forwards events as RelayEvent messages.
 */
export function handleActivitySubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  eventBus: EventBus,
  connState: ConnectionState,
  connectedBrowsers?: ConnectedBrowsersService,
  browserProfileService?: BrowserProfileService,
  closeConnection?: () => void,
): void {
  const { subscriptionId, browserProfileId, originMetadata } = msg;

  const releaseBrowserTabConnection = retainBrowserTabConnection(
    connState,
    browserProfileId,
    connectedBrowsers,
    closeConnection,
  );

  // Record origin metadata if available
  if (browserProfileService && browserProfileId && originMetadata) {
    browserProfileService
      .recordConnection(browserProfileId, originMetadata)
      .catch((err) => {
        console.warn(
          "[WS Relay] Failed to record browser profile origin:",
          err,
        );
      });
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  const { cleanup } = createActivitySubscription(eventBus, sendEvent, {
    logLabel: subscriptionId,
    onError: (err) => {
      console.error("[WS Relay] Error in activity subscription:", err);
    },
  });

  subscriptions.set(subscriptionId, () => {
    cleanup();
    releaseBrowserTabConnection();
  });

  getLogger().debug(`[WS Relay] Subscribed to activity (${subscriptionId})`);
}

function retainBrowserTabConnection(
  connState: ConnectionState,
  browserProfileId: string | undefined,
  connectedBrowsers: ConnectedBrowsersService | undefined,
  closeConnection: (() => void) | undefined,
): () => void {
  if (!connectedBrowsers || !browserProfileId) return () => {};

  let registration = connState.browserTabConnection;
  if (!registration) {
    registration = {
      browserProfileId,
      connectionId: connectedBrowsers.connect(
        browserProfileId,
        "ws",
        closeConnection,
      ),
      activitySubscriptionCount: 0,
    };
    connState.browserTabConnection = registration;
  } else if (registration.browserProfileId !== browserProfileId) {
    console.warn(
      "[WS Relay] Ignoring a second browser profile on one WebSocket connection",
    );
    return () => {};
  }

  registration.activitySubscriptionCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (connState.browserTabConnection !== registration) return;
    registration.activitySubscriptionCount = Math.max(
      0,
      registration.activitySubscriptionCount - 1,
    );
    if (registration.activitySubscriptionCount > 0) return;
    connectedBrowsers.disconnect(registration.connectionId);
    connState.browserTabConnection = null;
  };
}

/**
 * Handle a focused session-watch subscription.
 * Subscribes to targeted file-change events for a single session file.
 */
export function handleSessionWatchSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  focusedSessionWatchManager?: FocusedSessionWatchManager,
): void {
  const { subscriptionId, sessionId, projectId, provider } = msg;

  if (!focusedSessionWatchManager) {
    send({
      type: "response",
      id: subscriptionId,
      status: 503,
      body: { error: "Session watch service unavailable" },
    });
    return;
  }

  if (!sessionId || !projectId) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: {
        error: "sessionId and projectId required for session-watch channel",
      },
    });
    return;
  }

  let eventId = 0;
  const sendEvent = (eventType: string, data: unknown) => {
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  sendEvent("connected", { timestamp: new Date().toISOString() });

  const heartbeatInterval = setInterval(() => {
    sendEvent("heartbeat", { timestamp: new Date().toISOString() });
  }, 30_000);

  const cleanupFocusedWatch = focusedSessionWatchManager.subscribe(
    {
      sessionId,
      projectId: projectId as UrlProjectId,
      providerHint: provider,
    },
    (event) => {
      sendEvent("session-watch-change", event);
    },
  );

  subscriptions.set(subscriptionId, () => {
    clearInterval(heartbeatInterval);
    cleanupFocusedWatch();
  });

  getLogger().debug(
    `[WS Relay] Subscribed to session-watch ${sessionId} (${subscriptionId})`,
  );
}

/** Subscribe to the complete glossary-path set and later changes for a project. */
export async function handleGlossarySubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  manager?: ProjectGlossarySubscriptionManager,
): Promise<void> {
  const { subscriptionId, projectId } = msg;
  if (!manager) {
    send({
      type: "response",
      id: subscriptionId,
      status: 503,
      body: { error: "Glossary subscription service unavailable" },
    });
    return;
  }
  if (!projectId || !isUrlProjectId(projectId)) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "Valid projectId required for glossary channel" },
    });
    return;
  }

  let eventId = 0;
  let opened = false;
  let cancelled = false;
  let heartbeatInterval: NodeJS.Timeout | null = null;
  let release: (() => void) | null = null;
  const buffered: Array<{ eventType: string; data: unknown }> = [];
  const sendEvent = (eventType: string, data: unknown) => {
    if (!opened) {
      buffered.push({ eventType, data });
      return;
    }
    send({
      type: "event",
      subscriptionId,
      eventType,
      eventId: String(eventId++),
      data,
    });
  };

  const cleanup = () => {
    cancelled = true;
    if (heartbeatInterval) clearInterval(heartbeatInterval);
    heartbeatInterval = null;
    release?.();
    release = null;
  };
  subscriptions.set(subscriptionId, cleanup);

  try {
    release = await manager.subscribe(projectId, (event) => {
      sendEvent(event.type, event);
    });
  } catch (error) {
    if (subscriptions.get(subscriptionId) === cleanup) {
      subscriptions.delete(subscriptionId);
    }
    if (cancelled) return;
    send({
      type: "response",
      id: subscriptionId,
      status:
        error instanceof Error && error.message === "Project not found"
          ? 404
          : 500,
      body: {
        error:
          error instanceof Error
            ? error.message
            : "Glossary subscription failed",
      },
    });
    return;
  }
  if (cancelled || subscriptions.get(subscriptionId) !== cleanup) {
    release();
    release = null;
    return;
  }

  opened = true;
  send({
    type: "event",
    subscriptionId,
    eventType: "connected",
    eventId: String(eventId++),
    data: { timestamp: new Date().toISOString() },
  });
  for (const event of buffered) sendEvent(event.eventType, event.data);
  heartbeatInterval = setInterval(() => {
    sendEvent("heartbeat", { timestamp: new Date().toISOString() });
  }, 30_000);
  getLogger().debug(
    `[WS Relay] Subscribed to glossary project=${projectId} (${subscriptionId})`,
  );
}

/**
 * Handle a subscribe message.
 */
export async function handleSubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelaySubscribe,
  send: SendFn,
  supervisor: Supervisor,
  eventBus: EventBus,
  connState: ConnectionState,
  focusedSessionWatchManager?: FocusedSessionWatchManager,
  projectGlossarySubscriptionManager?: ProjectGlossarySubscriptionManager,
  connectedBrowsers?: ConnectedBrowsersService,
  browserProfileService?: BrowserProfileService,
  closeConnection?: () => void,
): Promise<void> {
  const { subscriptionId, channel } = msg;

  if (subscriptions.has(subscriptionId)) {
    send({
      type: "response",
      id: subscriptionId,
      status: 400,
      body: { error: "Subscription ID already in use" },
    });
    return;
  }

  switch (channel) {
    case "session":
      handleSessionSubscribe(subscriptions, msg, send, supervisor);
      break;

    case "activity":
      handleActivitySubscribe(
        subscriptions,
        msg,
        send,
        eventBus,
        connState,
        connectedBrowsers,
        browserProfileService,
        closeConnection,
      );
      break;

    case "session-watch":
      handleSessionWatchSubscribe(
        subscriptions,
        msg,
        send,
        focusedSessionWatchManager,
      );
      break;

    case "glossary":
      await handleGlossarySubscribe(
        subscriptions,
        msg,
        send,
        projectGlossarySubscriptionManager,
      );
      break;

    default:
      send({
        type: "response",
        id: subscriptionId,
        status: 400,
        body: { error: `Unknown channel: ${channel}` },
      });
  }
}

/**
 * Handle an unsubscribe message.
 */
export function handleUnsubscribe(
  subscriptions: Map<string, () => void>,
  msg: RelayUnsubscribe,
): void {
  const { subscriptionId } = msg;
  const cleanup = subscriptions.get(subscriptionId);
  if (cleanup) {
    cleanup();
    subscriptions.delete(subscriptionId);
    getLogger().debug(`[WS Relay] Unsubscribed (${subscriptionId})`);
  }
}

async function writeRelayUploadChunk(
  state: RelayUploadState,
  chunk: Buffer,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<number> {
  if (state.uploadKind === "draft-staging") {
    if (!attachmentStagingService) {
      throw new Error("Attachment staging is unavailable");
    }
    return attachmentStagingService.writeChunk(state.serverUploadId, chunk);
  }

  return uploadManager.writeChunk(state.serverUploadId, chunk);
}

async function cancelRelayUpload(
  state: RelayUploadState,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  if (state.uploadKind === "draft-staging") {
    await attachmentStagingService?.cancelUpload(state.serverUploadId);
    return;
  }

  await uploadManager.cancelUpload(state.serverUploadId);
}

/**
 * Handle upload_start message.
 */
export async function handleUploadStart(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadStart,
  send: SendFn,
  uploadManager: UploadManager,
): Promise<void> {
  const {
    uploadId,
    projectId,
    sessionId,
    filename,
    size,
    mimeType,
    width,
    height,
  } = msg;

  if (uploads.has(uploadId)) {
    send({
      type: "upload_error",
      uploadId,
      error: "Upload ID already in use",
    });
    return;
  }

  try {
    const { uploadId: serverUploadId } = await uploadManager.startUpload(
      projectId,
      sessionId,
      filename,
      size,
      mimeType,
      undefined,
      width !== undefined && height !== undefined
        ? { width, height }
        : undefined,
    );

    uploads.set(uploadId, {
      clientUploadId: uploadId,
      uploadKind: "session",
      serverUploadId,
      expectedSize: size,
      bytesReceived: 0,
      lastProgressReport: 0,
      pendingWrites: [],
    });

    send({ type: "upload_progress", uploadId, bytesReceived: 0 });

    console.log(
      `[WS Relay] Upload started: ${uploadId} (${filename}, ${size} bytes)`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to start upload";
    send(relayUploadError(uploadId, message, err));
  }
}

/**
 * Handle staged_upload_start message.
 */
export async function handleStagedUploadStart(
  uploads: Map<string, RelayUploadState>,
  msg: RelayStagedUploadStart,
  send: SendFn,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  const { uploadId, batchId, filename, size, mimeType, width, height } = msg;

  if (uploads.has(uploadId)) {
    send({
      type: "upload_error",
      uploadId,
      error: "Upload ID already in use",
    });
    return;
  }

  if (!attachmentStagingService) {
    send({
      type: "upload_error",
      uploadId,
      error: "Attachment staging is unavailable",
    });
    return;
  }

  try {
    const { uploadId: serverUploadId } =
      await attachmentStagingService.startDraftUpload({
        batchId,
        originalName: filename,
        size,
        mimeType,
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      });

    uploads.set(uploadId, {
      clientUploadId: uploadId,
      uploadKind: "draft-staging",
      serverUploadId,
      expectedSize: size,
      bytesReceived: 0,
      lastProgressReport: 0,
      pendingWrites: [],
    });

    send({ type: "upload_progress", uploadId, bytesReceived: 0 });

    console.log(
      `[WS Relay] Staged upload started: ${uploadId} (${filename}, ${size} bytes)`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to start staged upload";
    send(relayUploadError(uploadId, message, err));
  }
}

/**
 * Handle upload_chunk message.
 */
export async function handleUploadChunk(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadChunk,
  send: SendFn,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  const { uploadId, offset, data } = msg;

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  if (offset !== state.bytesReceived) {
    send({
      type: "upload_error",
      uploadId,
      error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
    });
    return;
  }

  // Track this write so handleUploadEnd can wait for it
  let writeResolve!: () => void;
  const writeTracker = new Promise<void>((resolve) => {
    writeResolve = resolve;
  });
  state.pendingWrites.push(writeTracker);

  try {
    const chunk = Buffer.from(data, "base64");
    const bytesReceived = await writeRelayUploadChunk(
      state,
      chunk,
      uploadManager,
      attachmentStagingService,
    );

    state.bytesReceived = bytesReceived;

    if (
      bytesReceived - state.lastProgressReport >= PROGRESS_INTERVAL ||
      bytesReceived === state.expectedSize
    ) {
      send({ type: "upload_progress", uploadId, bytesReceived });
      state.lastProgressReport = bytesReceived;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write chunk";
    send(relayUploadError(uploadId, message, err));
    uploads.delete(uploadId);
    try {
      await cancelRelayUpload(state, uploadManager, attachmentStagingService);
    } catch {
      // Ignore cleanup errors
    }
  } finally {
    writeResolve?.();
  }
}

/**
 * Handle binary upload chunk (format 0x02).
 * Payload format: [16 bytes UUID][8 bytes offset big-endian][chunk data]
 */
export async function handleBinaryUploadChunk(
  uploads: Map<string, RelayUploadState>,
  payload: Uint8Array,
  send: SendFn,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  let uploadId: string;
  let offset: number;
  let data: Uint8Array;
  try {
    ({ uploadId, offset, data } = decodeUploadChunkPayload(payload));
  } catch (e) {
    const message =
      e instanceof UploadChunkError
        ? `Invalid upload chunk: ${e.message}`
        : "Invalid binary upload chunk format";
    console.warn(`[WS Relay] ${message}`, e);
    send({
      type: "response",
      id: "binary-upload-error",
      status: 400,
      body: { error: message },
    });
    return;
  }

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  if (offset !== state.bytesReceived) {
    send({
      type: "upload_error",
      uploadId,
      error: `Invalid offset: expected ${state.bytesReceived}, got ${offset}`,
    });
    return;
  }

  // Track this write so handleUploadEnd can wait for it
  let writeResolve!: () => void;
  const writeTracker = new Promise<void>((resolve) => {
    writeResolve = resolve;
  });
  state.pendingWrites.push(writeTracker);

  try {
    const bytesReceived = await writeRelayUploadChunk(
      state,
      Buffer.from(data),
      uploadManager,
      attachmentStagingService,
    );

    state.bytesReceived = bytesReceived;

    if (
      bytesReceived - state.lastProgressReport >= PROGRESS_INTERVAL ||
      bytesReceived === state.expectedSize
    ) {
      send({ type: "upload_progress", uploadId, bytesReceived });
      state.lastProgressReport = bytesReceived;
    }
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to write chunk";
    send(relayUploadError(uploadId, message, err));
    uploads.delete(uploadId);
    try {
      await cancelRelayUpload(state, uploadManager, attachmentStagingService);
    } catch {
      // Ignore cleanup errors
    }
  } finally {
    writeResolve?.();
  }
}

/**
 * Handle upload_end message.
 */
export async function handleUploadEnd(
  uploads: Map<string, RelayUploadState>,
  msg: RelayUploadEnd,
  send: SendFn,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  const { uploadId } = msg;

  const state = uploads.get(uploadId);
  if (!state) {
    send({ type: "upload_error", uploadId, error: "Upload not found" });
    return;
  }

  // Wait for any pending chunk writes to complete before finalizing
  await Promise.all(state.pendingWrites);

  try {
    if (state.uploadKind === "draft-staging") {
      if (!attachmentStagingService) {
        throw new Error("Attachment staging is unavailable");
      }
      const stagedRef = await attachmentStagingService.completeUpload(
        state.serverUploadId,
      );
      uploads.delete(uploadId);
      send({
        type: "upload_complete",
        uploadId,
        stagedRef,
        batchId: stagedRef.batchId,
      });
      getLogger().debug(
        `[WS Relay] Staged upload complete: ${uploadId} (${stagedRef.size} bytes)`,
      );
      return;
    }

    const file = await uploadManager.completeUpload(state.serverUploadId);
    uploads.delete(uploadId);
    send({ type: "upload_complete", uploadId, file });
    getLogger().debug(
      `[WS Relay] Upload complete: ${uploadId} (${file.size} bytes)`,
    );
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to complete upload";
    send(relayUploadError(uploadId, message, err));
    uploads.delete(uploadId);
    try {
      await cancelRelayUpload(state, uploadManager, attachmentStagingService);
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Clean up all active uploads for a connection.
 */
export async function cleanupUploads(
  uploads: Map<string, RelayUploadState>,
  uploadManager: UploadManager,
  attachmentStagingService?: AttachmentStagingService,
): Promise<void> {
  for (const [clientId, state] of uploads) {
    try {
      await cancelRelayUpload(state, uploadManager, attachmentStagingService);
      console.log(`[WS Relay] Cancelled upload on disconnect: ${clientId}`);
    } catch (err) {
      console.error(`[WS Relay] Error cancelling upload ${clientId}:`, err);
    }
  }
  uploads.clear();
}

/**
 * Options for handleMessage that differ between direct and relay connections.
 */
export interface HandleMessageOptions {
  /**
   * Whether the message was received as a binary frame.
   * If provided, this takes precedence over isBinaryData() check.
   * Required for raw ws connections where all data arrives as Buffers.
   */
  isBinary?: boolean;
  /** Per-connection relayed speech session holder. */
  speechSessionRef?: { current: SpeechWebSocketSession | null };
}

/**
 * Handle incoming WebSocket messages.
 * Supports both text frames (JSON) and binary frames (format byte + payload or encrypted envelope).
 */
export async function handleMessage(
  ws: WSAdapter,
  subscriptions: Map<string, () => void>,
  uploads: Map<string, RelayUploadState>,
  connState: ConnectionState,
  send: SendFn,
  data: unknown,
  deps: RelayHandlerDeps,
  options: HandleMessageOptions,
  deviceSessions?: Set<string>,
): Promise<void> {
  const {
    app,
    baseUrl,
    supervisor,
    eventBus,
    uploadManager,
    attachmentStagingService,
    remoteAccessService,
    remoteSessionService,
    securityClientService,
  } = deps;
  const srpRequiredPolicy = isPolicySrpRequired(connState.connectionPolicy);
  const getSpeechSession = (): SpeechWebSocketSession | null => {
    if (!options.speechSessionRef) {
      send({
        type: "speech_event",
        message: {
          type: "error",
          message: "Speech relay is unavailable on this connection",
        },
      });
      return null;
    }

    if (!deps.speechBackendRegistry) {
      send({
        type: "speech_event",
        message: {
          type: "error",
          message: "Speech relay is not configured",
        },
      });
      return null;
    }

    if (!options.speechSessionRef.current) {
      options.speechSessionRef.current = createSpeechWebSocketSession(
        {
          speechBackendRegistry: deps.speechBackendRegistry,
          dataDir: deps.dataDir,
          serverSettingsService: deps.serverSettingsService,
        },
        (message) =>
          send({
            type: "speech_event",
            message: message as RelaySpeechEvent["message"],
          }),
      );
      send({
        type: "speech_event",
        message: { type: "ready" },
      });
    }

    return options.speechSessionRef.current;
  };

  // Debug: log incoming data type and preview
  // Check Buffer BEFORE Uint8Array since Buffer extends Uint8Array
  const dataType =
    data === null
      ? "null"
      : data === undefined
        ? "undefined"
        : typeof data === "string"
          ? `string(${data.length})`
          : Buffer.isBuffer(data)
            ? `Buffer(${data.length})`
            : data instanceof ArrayBuffer
              ? `ArrayBuffer(${data.byteLength})`
              : data instanceof Uint8Array
                ? `Uint8Array(${data.length})`
                : `unknown(${typeof data})`;
  const preview =
    typeof data === "string"
      ? data.slice(0, 100)
      : data instanceof Uint8Array || Buffer.isBuffer(data)
        ? `[${Array.from(data.slice(0, 20))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join(" ")}...]`
        : String(data).slice(0, 100);
  getLogger().debug(
    `[WS Relay] handleMessage: type=${dataType}, isBinary=${options.isBinary}, preview=${preview}`,
  );

  const routeClientMessage = async (msg: RemoteClientMessage): Promise<void> =>
    routeClientMessageSafely(msg, send, {
      onRequest: async (requestMsg) => {
        // Tunneled HTTP requests are independent: each carries its own id and
        // handleRequest always answers (it never throws). Do not await here —
        // the per-connection message queue must keep decrypt/auth/route order,
        // but a slow request (e.g. a session index revalidation behind
        // /api/sessions) must not head-of-line block later tunneled requests
        // the way it never would over plain HTTP.
        void handleRequest(requestMsg, send, ws, app, baseUrl, connState);
      },
      onSubscribe: async (subscribeMsg) =>
        handleSubscribe(
          subscriptions,
          subscribeMsg,
          send,
          supervisor,
          eventBus,
          connState,
          deps.focusedSessionWatchManager,
          deps.projectGlossarySubscriptionManager,
          deps.connectedBrowsers,
          deps.browserProfileService,
          () => ws.close(4004, "Legacy browser profile revoked"),
        ),
      onUnsubscribe: async (unsubscribeMsg) =>
        handleUnsubscribe(subscriptions, unsubscribeMsg),
      onUploadStart: async (uploadStartMsg) =>
        handleUploadStart(uploads, uploadStartMsg, send, uploadManager),
      onStagedUploadStart: async (uploadStartMsg) =>
        handleStagedUploadStart(
          uploads,
          uploadStartMsg,
          send,
          attachmentStagingService,
        ),
      onUploadChunk: async (uploadChunkMsg) =>
        handleUploadChunk(
          uploads,
          uploadChunkMsg,
          send,
          uploadManager,
          attachmentStagingService,
        ),
      onUploadEnd: async (uploadEndMsg) =>
        handleUploadEnd(
          uploads,
          uploadEndMsg,
          send,
          uploadManager,
          attachmentStagingService,
        ),
      onPing: async (pingMsg) => send({ type: "pong", id: pingMsg.id }),
      onSpeechControl: async (speechMsg) => {
        const session = getSpeechSession();
        if (!session) return;
        session.handleMessage(JSON.stringify(speechMsg.message));
      },
      onDeviceMessage: deps.deviceBridgeService
        ? (() => {
            const bridge = deps.deviceBridgeService;
            return async (emulatorMsg: RemoteClientMessage) => {
              switch (emulatorMsg.type) {
                case "device_stream_start":
                  deviceSessions?.add(emulatorMsg.sessionId);
                  await bridge.startStream(emulatorMsg, send);
                  break;
                case "device_stream_stop":
                  deviceSessions?.delete(emulatorMsg.sessionId);
                  bridge.stopStream(emulatorMsg);
                  break;
                case "device_webrtc_answer":
                  bridge.handleAnswer(emulatorMsg);
                  break;
                case "device_ice_candidate":
                  bridge.handleICE(emulatorMsg);
                  break;
              }
            };
          })()
        : undefined,
    });

  const parsed = await decodeFrameToParsedMessage(
    ws,
    data,
    options,
    connState,
    srpRequiredPolicy,
    {
      uploads,
      send,
      uploadManager,
      attachmentStagingService,
      routeClientMessage,
      handleSpeechAudio: async (payload) => {
        const session = getSpeechSession();
        if (!session) return;
        session.handleMessage(Buffer.from(payload) as SpeechWsData);
      },
      handleBinaryUploadChunk,
    },
  );
  if (parsed === null) {
    return;
  }

  // Handle SRP messages first (always plaintext)
  if (isSrpSessionResumeInit(parsed)) {
    await handleSrpResumeInit(ws, connState, parsed, remoteSessionService);
    return;
  }

  if (isSrpSessionResume(parsed)) {
    await handleSrpResume(ws, connState, parsed, remoteSessionService);
    return;
  }

  if (isSrpClientHello(parsed)) {
    await handleSrpHello(ws, connState, parsed, remoteAccessService);
    return;
  }

  if (isSrpClientProof(parsed)) {
    await handleSrpProof(
      ws,
      connState,
      parsed,
      parsed.A,
      remoteSessionService,
      securityClientService,
    );
    return;
  }

  const msg = parseApplicationClientMessage(
    ws,
    connState,
    srpRequiredPolicy,
    parsed,
  );
  if (!msg) {
    return;
  }

  await routeClientMessage(msg);
}

/**
 * Clean up emulator streaming sessions on connection close.
 */
export function cleanupDeviceSessions(
  deviceSessions: Set<string>,
  deviceBridgeService?: DeviceBridgeService,
): void {
  if (!deviceBridgeService || deviceSessions.size === 0) return;
  for (const sessionId of deviceSessions) {
    try {
      deviceBridgeService.stopStream({
        type: "device_stream_stop",
        sessionId,
      });
    } catch (err) {
      console.error(
        `[WS Relay] Error cleaning up emulator session ${sessionId}:`,
        err,
      );
    }
  }
  deviceSessions.clear();
}

/**
 * Clean up subscriptions on connection close.
 */
export function cleanupSubscriptions(
  subscriptions: Map<string, () => void>,
): void {
  for (const [id, cleanup] of subscriptions) {
    try {
      cleanup();
    } catch (err) {
      console.error(`[WS Relay] Error cleaning up subscription ${id}:`, err);
    }
  }
  subscriptions.clear();
}
