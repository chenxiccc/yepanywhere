import { homedir } from "node:os";
import { join } from "node:path";
import { type TrustedProxy, parseTrustedProxies } from "./client-ip.js";
import { hasAsciiControlCharacter } from "./ascii.js";

export type PushProviderMode = "fake" | "fcm";

export interface PushBrokerConfig {
  host: string;
  port: number;
  dataDir: string;
  provider: PushProviderMode;
  fcmProjectId?: string;
  providerTimeoutMs: number;
  trustedProxies: TrustedProxy[];
  invalidTrustedProxyEntries: string[];
  logLevel: string;
}

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
): PushBrokerConfig {
  const provider = parseProvider(env.PUSH_BROKER_PROVIDER);
  if (provider === "fake" && env.NODE_ENV === "production") {
    throw new Error("The fake push provider is not allowed in production");
  }

  const fcmProjectId = env.PUSH_BROKER_FCM_PROJECT_ID?.trim();
  if (provider === "fcm" && !fcmProjectId) {
    throw new Error(
      "PUSH_BROKER_FCM_PROJECT_ID is required for the FCM provider",
    );
  }

  const trustedProxyResult = parseTrustedProxies(
    env.PUSH_BROKER_TRUSTED_PROXIES,
  );

  return {
    host: parseHost(env.PUSH_BROKER_HOST),
    port: parsePort(env.PUSH_BROKER_PORT),
    dataDir: env.PUSH_BROKER_DATA_DIR ?? join(homedir(), ".yep-push-broker"),
    provider,
    fcmProjectId,
    providerTimeoutMs: parsePositiveInteger(
      "PUSH_BROKER_PROVIDER_TIMEOUT_MS",
      env.PUSH_BROKER_PROVIDER_TIMEOUT_MS,
      10_000,
    ),
    trustedProxies: trustedProxyResult.proxies,
    invalidTrustedProxyEntries: trustedProxyResult.invalidEntries,
    logLevel: env.PUSH_BROKER_LOG_LEVEL ?? "info",
  };
}

function parseHost(value: string | undefined): string {
  if (value === undefined || value === "") return "127.0.0.1";
  if (value.trim() !== value || hasAsciiControlCharacter(value, true)) {
    throw new Error(
      "PUSH_BROKER_HOST must be a non-empty host name or address",
    );
  }
  return value;
}

function parseProvider(value: string | undefined): PushProviderMode {
  if (value === "fake" || value === "fcm") return value;
  if (value === undefined || value === "") {
    throw new Error("PUSH_BROKER_PROVIDER must be set to fake or fcm");
  }
  throw new Error(`Unsupported PUSH_BROKER_PROVIDER: ${value}`);
}

function parsePort(value: string | undefined): number {
  if (value === undefined || value === "") return 4500;
  if (!/^\d+$/.test(value)) {
    throw new Error("PUSH_BROKER_PORT must be an integer from 0 to 65535");
  }
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error("PUSH_BROKER_PORT must be an integer from 0 to 65535");
  }
  return port;
}

function parsePositiveInteger(
  name: string,
  value: string | undefined,
  defaultValue: number,
): number {
  if (value === undefined || value === "") return defaultValue;
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}
