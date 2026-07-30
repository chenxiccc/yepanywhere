import { Hono } from "hono";

export interface ServerInfoOptions {
  host: string;
  /** Static port, or a live accessor when the OS selected port 0 at bind time. */
  port: number | (() => number);
  installId?: string;
  /** Whether device bridge streaming is available (ADB detected + sidecar binary exists) */
  deviceBridgeAvailable?: boolean;
}

export interface ServerCapabilities {
  /** Whether device bridge streaming is available */
  deviceBridge: boolean;
}

export interface ServerInfo {
  /** The host/interface the server is bound to (e.g., "127.0.0.1" or "0.0.0.0") */
  host: string;
  /** The port the server is listening on */
  port: number;
  /** Whether the server is bound to all interfaces (0.0.0.0) */
  boundToAllInterfaces: boolean;
  /** Whether the server is localhost-only */
  localhostOnly: boolean;
  /** Unique installation identifier for this server instance */
  installId?: string;
  /** Server capabilities (optional features) */
  capabilities?: ServerCapabilities;
}

export function createServerInfoRoutes(options: ServerInfoOptions) {
  const app = new Hono();

  app.get("/", (c) => {
    const port =
      typeof options.port === "function" ? options.port() : options.port;
    const info: ServerInfo = {
      host: options.host,
      port,
      boundToAllInterfaces: options.host === "0.0.0.0" || options.host === "::",
      localhostOnly:
        options.host === "127.0.0.1" ||
        options.host === "localhost" ||
        options.host === "::1",
      installId: options.installId,
      capabilities: {
        deviceBridge: options.deviceBridgeAvailable ?? false,
      },
    };
    return c.json(info);
  });

  return app;
}
