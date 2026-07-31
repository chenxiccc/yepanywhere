import { loadConfig } from "./config.js";
import { createBrokerLogger } from "./logger.js";
import { FakePushProvider } from "./providers/fake.js";
import { createPushBrokerServer } from "./server.js";
import type { PushProvider } from "./types.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createBrokerLogger(config.logLevel);

  for (const entry of config.invalidTrustedProxyEntries) {
    logger.warn(
      { trustedProxyEntry: entry },
      "Ignoring invalid trusted-proxy entry",
    );
  }

  const provider = await createConfiguredProvider(
    config.provider,
    config.fcmProjectId,
  );
  const broker = await createPushBrokerServer({
    provider,
    host: config.host,
    port: config.port,
    dataDir: config.dataDir,
    logger,
    providerTimeoutMs: config.providerTimeoutMs,
    trustedProxies: config.trustedProxies,
  });

  logger.info(
    {
      host: config.host,
      port: broker.port,
      provider: provider.name,
    },
    "Push broker listening",
  );

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Stopping push broker");
    try {
      await broker.close();
    } catch {
      logger.error("Push broker shutdown failed");
      process.exitCode = 1;
    }
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
}

async function createConfiguredProvider(
  provider: "fake" | "fcm",
  fcmProjectId: string | undefined,
): Promise<PushProvider> {
  if (provider === "fake") return new FakePushProvider();
  const { createFirebasePushProvider } = await import(
    "./providers/firebase.js"
  );
  return createFirebasePushProvider(fcmProjectId ?? "");
}

main().catch((error: unknown) => {
  const logger = createBrokerLogger("error");
  logger.fatal(
    {
      errorName: error instanceof Error ? error.name : "UnknownError",
      errorMessage:
        error instanceof Error ? error.message : "Unknown startup error",
    },
    "Push broker startup failed",
  );
  process.exitCode = 1;
});
