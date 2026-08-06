/**
 * Relay server factory for both production and testing use.
 *
 * Exports a createRelayServer function that returns a fully configured
 * server instance that can be started on any port.
 */

import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { RELAY_CLIENT_MUX_V1_CAPABILITY } from "@yep-anywhere/shared";
import type Database from "better-sqlite3";
import { Hono } from "hono";
import { cors } from "hono/cors";
import pino, { type Logger } from "pino";
import { WebSocketServer } from "ws";
import { getClientIp, parseTrustedProxies } from "./client-ip.js";
import {
  DEFAULT_RELAY_WEBSOCKET_MAX_MESSAGE_BYTES,
  type RelayConfig,
} from "./config.js";
import { ConnectionManager } from "./connections.js";
import { createDb, createTestDb } from "./db.js";
import type { LogLevel } from "./logger.js";
import { createMuxHandler } from "./mux-handler.js";
import {
  getRelayCorsAllowOrigin,
  isRelayOriginAllowed,
  parseRelayAllowedOrigins,
} from "./origin-policy.js";
import { UsernameRegistry } from "./registry.js";
import { generateRelayStatsHtml } from "./stats.js";
import { createRelayTelemetryRecorder } from "./telemetry.js";
import {
  DEFAULT_UNAUTHENTICATED_CONNECTION_LIMIT_PER_IP,
  DEFAULT_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS,
  UnauthenticatedConnectionLimiter,
  rejectUpgrade,
} from "./unauthenticated-limiter.js";
import { createWsHandler } from "./ws-handler.js";

export interface RelayServerOptions {
  /** Port to listen on (default: 0 for random available port) */
  port?: number;
  /** Maximum bytes accepted in one physical WebSocket message. */
  webSocketMaxMessageBytes?: number;
  /** Data directory for SQLite database (default: in-memory for testing) */
  dataDir?: string;
  /** Use in-memory database for testing */
  inMemoryDb?: boolean;
  /** Log level (default: warn) */
  logLevel?: string;
  /** Ping interval for waiting connections in ms (default: 60000) */
  pingIntervalMs?: number;
  /** Pong timeout in ms (default: 30000) */
  pongTimeoutMs?: number;
  /** Days of inactivity before username can be reclaimed (default: 90) */
  reclaimDays?: number;
  /** Disable pretty printing (for tests) */
  disablePrettyPrint?: boolean;
  /** Structured telemetry directory override */
  telemetryDir?: string;
  /** Structured telemetry sampling interval override */
  telemetrySampleIntervalMs?: number;
  /** Structured telemetry node ID override */
  telemetryNodeId?: string;
  /** Disable structured telemetry */
  disableTelemetry?: boolean;
  /** Pending unauthenticated WebSocket connections allowed per source IP. */
  unauthenticatedConnectionLimitPerIp?: number;
  /** Time allowed for a new WebSocket to send a valid relay protocol message. */
  unauthenticatedConnectionTimeoutMs?: number;
  /** Maximum logical circuits carried by one client mux socket. */
  muxMaxCircuitsPerSocket?: number;
  /** Maximum live mux circuits associated with one effective client IP. */
  muxMaxCircuitsPerIp?: number;
  /** Maximum circuit-open attempts per minute on one mux socket. */
  muxOpenAttemptsPerMinutePerSocket?: number;
  /** Maximum circuit-open attempts per minute from one effective client IP. */
  muxOpenAttemptsPerMinutePerIp?: number;
  /** Maximum circuit-open attempts per minute for one IP/username pair. */
  muxOpenAttemptsPerMinutePerIpUsername?: number;
  /** Maximum opaque inner payload size accepted by mux. */
  muxMaxFrameBytes?: number;
  /** Maximum queued relay-to-client bytes for one mux circuit. */
  muxMaxQueuedBytesPerCircuit?: number;
  /** Maximum queued relay-to-client bytes for one physical mux socket. */
  muxMaxQueuedBytesPerSocket?: number;
  /** Physical socket bufferedAmount threshold before mux queues writes. */
  muxBufferedAmountHighWaterBytes?: number;
  /** Maximum lifetime of a mux socket with no circuits. */
  muxIdleTimeoutMs?: number;
  /**
   * Comma-separated list of IPs/CIDRs whose `X-Forwarded-For` is trusted
   * for client-IP resolution. Default: none.
   */
  trustedProxies?: string;
  /** Comma-separated browser Origin allowlist for relay HTTP/WS access. */
  allowedOrigins?: string;
}

export interface RelayServer {
  /** The underlying HTTP server */
  server: Server;
  /** The WebSocket server */
  wss: WebSocketServer;
  /** The port the server is listening on */
  port: number;
  /** The Hono app instance */
  app: Hono;
  /** The connection manager */
  connectionManager: ConnectionManager;
  /** The username registry */
  registry: UsernameRegistry;
  /** The database instance */
  db: Database.Database;
  /** The logger instance */
  logger: Logger;
  /** Structured telemetry status */
  telemetry: ReturnType<
    ReturnType<typeof createRelayTelemetryRecorder>["getStatus"]
  >;
  /** Close the server and clean up resources */
  close(): Promise<void>;
}

/**
 * Creates a relay server instance.
 *
 * @param options - Server configuration options
 * @returns A promise that resolves to a RelayServer instance
 */
export async function createRelayServer(
  options: RelayServerOptions = {},
): Promise<RelayServer> {
  const logLevel = options.logLevel ?? "warn";

  const config: RelayConfig = {
    port: options.port ?? 0, // 0 = random available port
    webSocketMaxMessageBytes:
      options.webSocketMaxMessageBytes ??
      DEFAULT_RELAY_WEBSOCKET_MAX_MESSAGE_BYTES,
    portFile: null, // Not used in test/factory mode - caller checks .port directly
    dataDir: options.dataDir ?? "",
    pingIntervalMs: options.pingIntervalMs ?? 60_000,
    pongTimeoutMs: options.pongTimeoutMs ?? 30_000,
    reclaimDays: options.reclaimDays ?? 90,
    unauthenticatedConnectionLimitPerIp:
      options.unauthenticatedConnectionLimitPerIp ??
      DEFAULT_UNAUTHENTICATED_CONNECTION_LIMIT_PER_IP,
    unauthenticatedConnectionTimeoutMs:
      options.unauthenticatedConnectionTimeoutMs ??
      DEFAULT_UNAUTHENTICATED_CONNECTION_TIMEOUT_MS,
    muxMaxCircuitsPerSocket: options.muxMaxCircuitsPerSocket ?? 5,
    muxMaxCircuitsPerIp: options.muxMaxCircuitsPerIp ?? 20,
    muxOpenAttemptsPerMinutePerSocket:
      options.muxOpenAttemptsPerMinutePerSocket ?? 20,
    muxOpenAttemptsPerMinutePerIp: options.muxOpenAttemptsPerMinutePerIp ?? 60,
    muxOpenAttemptsPerMinutePerIpUsername:
      options.muxOpenAttemptsPerMinutePerIpUsername ?? 6,
    muxMaxFrameBytes: options.muxMaxFrameBytes ?? 2 * 1024 * 1024,
    muxMaxQueuedBytesPerCircuit:
      options.muxMaxQueuedBytesPerCircuit ?? 2 * 1024 * 1024,
    muxMaxQueuedBytesPerSocket:
      options.muxMaxQueuedBytesPerSocket ?? 8 * 1024 * 1024,
    muxBufferedAmountHighWaterBytes:
      options.muxBufferedAmountHighWaterBytes ?? 1024 * 1024,
    muxIdleTimeoutMs: options.muxIdleTimeoutMs ?? 30_000,
    trustedProxies: parseTrustedProxies(options.trustedProxies),
    allowedOrigins: parseRelayAllowedOrigins(options.allowedOrigins),
    logging: {
      logDir: "",
      logFile: "relay.log",
      consoleLevel: logLevel as LogLevel,
      fileLevel: logLevel as LogLevel,
      logToConsole: true,
      logToFile: false, // Disable file logging in test mode by default
      prettyPrint: !options.disablePrettyPrint,
    },
    telemetry: {
      enabled: options.disableTelemetry !== true,
      eventsDir:
        options.telemetryDir ??
        (options.dataDir
          ? join(options.dataDir, "telemetry")
          : join(tmpdir(), "yep-relay-telemetry")),
      nodeId: options.telemetryNodeId ?? "relay-test",
      sampleIntervalMs: options.telemetrySampleIntervalMs ?? 60_000,
    },
  };

  // Initialize logger (simple pino for server factory - no file logging in tests)
  const logger = pino({
    level: logLevel,
    ...(options.disablePrettyPrint
      ? {}
      : {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
            },
          },
        }),
  });
  if (config.allowedOrigins.invalidEntries.length > 0) {
    logger.warn(
      { invalidAllowedOrigins: config.allowedOrigins.invalidEntries },
      "Ignoring invalid relay allowed-origin entries",
    );
  }

  // Initialize database
  const db = options.inMemoryDb ? createTestDb() : createDb(config.dataDir);

  // Initialize registry
  const registry = new UsernameRegistry(db);

  // Run reclamation on startup
  const reclaimed = registry.reclaimInactive(config.reclaimDays);
  if (reclaimed > 0) {
    logger.info({ count: reclaimed }, "Reclaimed inactive usernames");
  }

  // Create connection manager
  const connectionManager = new ConnectionManager(registry);
  const unauthenticatedLimiter = new UnauthenticatedConnectionLimiter(
    config.unauthenticatedConnectionLimitPerIp,
    config.unauthenticatedConnectionTimeoutMs,
  );
  const telemetry = createRelayTelemetryRecorder(config.telemetry, logger);

  // Create Hono app for HTTP endpoints
  const app = new Hono();

  // Add CORS for browser clients
  app.use(
    "*",
    cors({
      origin: (origin) =>
        getRelayCorsAllowOrigin(origin, config.allowedOrigins),
      allowMethods: ["GET", "POST", "OPTIONS"],
      allowHeaders: ["Content-Type"],
    }),
  );

  // Health check endpoint
  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      uptime: process.uptime(),
      waiting: connectionManager.getWaitingCount(),
      pairs: connectionManager.getPairCount(),
      relayCapabilities: [RELAY_CLIENT_MUX_V1_CAPABILITY],
    });
  });

  // Status endpoint with more details
  app.get("/status", (c) => {
    return c.json({
      status: "ok",
      uptime: process.uptime(),
      waiting: connectionManager.getWaitingCount(),
      pairs: connectionManager.getPairCount(),
      registered: registry.count(),
      activeServers: connectionManager.getActiveServers(),
      compatibility: connectionManager.getActiveServerSummary(),
      mux: muxHandler.getStatus(),
      telemetry: telemetry.getStatus(),
      memory: process.memoryUsage(),
    });
  });

  app.get("/stats", async (c) => {
    const telemetryStatus = telemetry.getStatus();
    if (!telemetryStatus.enabled || !telemetryStatus.eventsDir) {
      return c.html(
        "<html><body><p>Relay telemetry is disabled.</p></body></html>",
      );
    }

    return c.html(
      await generateRelayStatsHtml(telemetryStatus.eventsDir),
      200,
      {
        "Cache-Control": "no-cache, no-store, must-revalidate",
      },
    );
  });

  // Check if a specific username has a server online (waiting for client)
  app.get("/online/:username", (c) => {
    const username = c.req.param("username");
    const online = connectionManager.isWaiting(username);
    return c.json({ online });
  });

  // Create WebSocket handler
  const wsHandler = createWsHandler(
    connectionManager,
    config,
    logger,
    telemetry,
    {
      onProtocolAccepted: (ws) => unauthenticatedLimiter.release(ws),
    },
  );
  const muxHandler = createMuxHandler(
    connectionManager,
    config,
    logger,
    telemetry,
    {
      onProtocolAccepted: (ws) => unauthenticatedLimiter.release(ws),
      onServerClaimed: (ws) => wsHandler.onServerClaimed(ws),
    },
  );
  telemetry.startSampling(() => {
    const mux = muxHandler.getStatus();
    return {
      waiting: connectionManager.getWaitingCount(),
      pairs: connectionManager.getPairCount(),
      registered: registry.count(),
      activeServers: connectionManager.getActiveServers().length,
      muxPhysicalSockets: mux.physicalSockets,
      muxCircuits: mux.liveCircuits,
    };
  });

  // Create HTTP server with Hono
  const requestListener = getRequestListener(app.fetch);
  const server = createServer(requestListener);

  // Create WebSocket server with noServer mode
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: config.webSocketMaxMessageBytes,
  });

  // Handle WebSocket connections
  wss.on("connection", (ws, request) => {
    const clientIp = getClientIp(request, config.trustedProxies);
    const path = (request.url ?? "/").split("?")[0];
    const isMux = path === "/mux";
    unauthenticatedLimiter.track(ws, clientIp);
    if (isMux) {
      muxHandler.onOpen(ws, clientIp);
    } else {
      wsHandler.onOpen(ws);
    }

    ws.on("message", (data, isBinary) => {
      if (isMux) {
        muxHandler.onMessage(ws, data, isBinary);
      } else {
        wsHandler.onMessage(ws, data, isBinary);
      }
    });

    ws.on("close", (code, reason) => {
      unauthenticatedLimiter.release(ws);
      if (isMux) {
        muxHandler.onClose(ws, code, reason);
      } else {
        wsHandler.onClose(ws, code, reason);
      }
    });

    ws.on("error", (error) => {
      if (isMux) {
        muxHandler.onError(ws, error);
      } else {
        wsHandler.onError(ws, error);
      }
    });

    ws.on("pong", () => {
      if (!isMux) wsHandler.onPong(ws);
    });
  });

  // Handle HTTP upgrade requests for WebSocket
  server.on("upgrade", (request, socket, head) => {
    const urlPath = request.url || "/";

    const upgradePath = urlPath.split("?")[0];
    if (upgradePath !== "/ws" && upgradePath !== "/mux") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    if (!isRelayOriginAllowed(origin, config.allowedOrigins)) {
      logger.info(
        { origin: origin ?? null, urlPath },
        "Rejected relay websocket origin",
      );
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }

    // Upgrade to WebSocket
    const ip = getClientIp(request, config.trustedProxies);
    if (!unauthenticatedLimiter.canAccept(ip)) {
      logger.info({ ip }, "Rejected unauthenticated relay connection over cap");
      rejectUpgrade(socket);
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  // Start server and wait for it to be ready
  return new Promise((resolve) => {
    server.listen(config.port, () => {
      const address = server.address();
      const port =
        typeof address === "object" && address ? address.port : config.port;

      logger.info(
        { port },
        `Relay server listening on http://localhost:${port}`,
      );

      resolve({
        server,
        wss,
        port,
        app,
        connectionManager,
        registry,
        db,
        logger,
        telemetry: telemetry.getStatus(),
        async close() {
          // Close all WebSocket connections first
          for (const client of wss.clients) {
            try {
              client.close(1001, "Server shutting down");
            } catch {
              // Ignore errors
            }
          }

          // Close the WebSocket server
          wss.close();

          await telemetry.close();

          // Close the database
          db.close();

          // Close the HTTP server
          return new Promise<void>((resolveClose) => {
            server.close(() => resolveClose());
          });
        },
      });
    });
  });
}
