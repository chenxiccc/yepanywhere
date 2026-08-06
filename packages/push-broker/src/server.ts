import { type Server, createServer } from "node:http";
import { getRequestListener } from "@hono/node-server";
import type Database from "better-sqlite3";
import pino, { type Logger } from "pino";
import { type BrokerRateLimitOptions, createBrokerApp } from "./app.js";
import type { TrustedProxy } from "./client-ip.js";
import { createDatabase, createTestDatabase } from "./db.js";
import { PushRepository, type PushRepositoryOptions } from "./repository.js";
import type { PushProvider } from "./types.js";

export interface PushBrokerServerOptions {
  provider: PushProvider;
  host?: string;
  port?: number;
  dataDir?: string;
  inMemoryDb?: boolean;
  database?: Database.Database;
  logger?: Logger;
  trustedProxies?: TrustedProxy[];
  rateLimits?: Partial<BrokerRateLimitOptions>;
  providerTimeoutMs?: number;
  repository?: PushRepositoryOptions;
  now?: () => number;
}

export interface PushBrokerServer {
  server: Server;
  port: number;
  db: Database.Database;
  repository: PushRepository;
  provider: PushProvider;
  close(): Promise<void>;
}

export async function createPushBrokerServer(
  options: PushBrokerServerOptions,
): Promise<PushBrokerServer> {
  const logger = options.logger ?? pino({ level: "silent" });
  const db =
    options.database ??
    (options.inMemoryDb
      ? createTestDatabase()
      : createDatabase(
          options.dataDir ??
            requiredOption("dataDir is required for a persistent broker"),
        ));
  const repository = new PushRepository(db, {
    ...options.repository,
    now: options.now ?? options.repository?.now,
  });
  const app = createBrokerApp({
    repository,
    provider: options.provider,
    logger,
    trustedProxies: options.trustedProxies,
    rateLimits: options.rateLimits,
    providerTimeoutMs: options.providerTimeoutMs,
    now: options.now,
  });
  const server = createServer(getRequestListener(app.fetch));

  try {
    await listen(server, options.port ?? 0, options.host ?? "127.0.0.1");
  } catch (error) {
    db.close();
    await options.provider.close?.();
    throw error;
  }

  const address = server.address();
  const port =
    typeof address === "object" && address ? address.port : (options.port ?? 0);
  let closed = false;

  return {
    server,
    port,
    db,
    repository,
    provider: options.provider,
    async close() {
      if (closed) return;
      closed = true;
      let closeError: unknown;
      try {
        await closeHttpServer(server);
      } catch (error) {
        closeError = error;
      }
      try {
        await options.provider.close?.();
      } catch (error) {
        closeError ??= error;
      }
      try {
        db.close();
      } catch (error) {
        closeError ??= error;
      }
      if (closeError) throw closeError;
    },
  };
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.keepAliveTimeout = 5_000;
    server.maxHeadersCount = 100;
    server.listen(port, host);
  });
}

function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function requiredOption(message: string): never {
  throw new Error(message);
}
