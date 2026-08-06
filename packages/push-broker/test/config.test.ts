import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("push broker config", () => {
  it("requires an explicit provider", () => {
    expect(() => loadConfig({})).toThrow("PUSH_BROKER_PROVIDER must be set");
  });

  it("allows the fake provider only outside production", () => {
    expect(loadConfig({ PUSH_BROKER_PROVIDER: "fake" }).provider).toBe("fake");
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        PUSH_BROKER_PROVIDER: "fake",
      }),
    ).toThrow("not allowed in production");
  });

  it("requires a project id for FCM without loading credentials", () => {
    expect(() => loadConfig({ PUSH_BROKER_PROVIDER: "fcm" })).toThrow(
      "PUSH_BROKER_FCM_PROJECT_ID",
    );
    expect(
      loadConfig({
        PUSH_BROKER_PROVIDER: "fcm",
        PUSH_BROKER_FCM_PROJECT_ID: "ya-development",
      }),
    ).toMatchObject({
      provider: "fcm",
      fcmProjectId: "ya-development",
    });
  });

  it("validates port and trusted-proxy configuration", () => {
    expect(() =>
      loadConfig({
        PUSH_BROKER_PROVIDER: "fake",
        PUSH_BROKER_PORT: "-1",
      }),
    ).toThrow("PUSH_BROKER_PORT");

    const config = loadConfig({
      PUSH_BROKER_PROVIDER: "fake",
      PUSH_BROKER_HOST: "localhost",
      PUSH_BROKER_PORT: "0",
      PUSH_BROKER_PROVIDER_TIMEOUT_MS: "2500",
      PUSH_BROKER_TRUSTED_PROXIES: "127.0.0.1,bad",
    });
    expect(config.host).toBe("localhost");
    expect(config.port).toBe(0);
    expect(config.providerTimeoutMs).toBe(2_500);
    expect(config.trustedProxies).toHaveLength(1);
    expect(config.invalidTrustedProxyEntries).toEqual(["bad"]);

    expect(() =>
      loadConfig({
        PUSH_BROKER_PROVIDER: "fake",
        PUSH_BROKER_HOST: "bad host",
      }),
    ).toThrow("PUSH_BROKER_HOST");
    expect(() =>
      loadConfig({
        PUSH_BROKER_PROVIDER: "fake",
        PUSH_BROKER_PROVIDER_TIMEOUT_MS: "0",
      }),
    ).toThrow("PUSH_BROKER_PROVIDER_TIMEOUT_MS");
  });
});
