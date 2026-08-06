import { Writable } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { BrokerRateLimitOptions } from "../../src/app.js";
import { generateOpaqueId, generateSecret } from "../../src/credentials.js";
import { FakePushProvider } from "../../src/providers/fake.js";
import {
  type PushBrokerServer,
  createPushBrokerServer,
} from "../../src/server.js";
import type { PushDelivery, PushProvider } from "../../src/types.js";

interface InstallationCredentials {
  installationId: string;
  installationSecret: string;
}

interface SubscriptionCredentials {
  subscriptionId: string;
  sendSecret: string;
}

describe("push broker HTTP contract", () => {
  let broker: PushBrokerServer | undefined;

  afterEach(async () => {
    await broker?.close();
    broker = undefined;
  });

  it("registers, subscribes, and sends only to the stored target", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider);
    const installation = await createInstallation(
      broker,
      "stored-firebase-target",
    );
    const subscription = await createSubscription(broker, installation);

    const response = await brokerFetch(
      broker,
      `/v1/subscriptions/${subscription.subscriptionId}/notifications`,
      {
        method: "POST",
        secret: subscription.sendSecret,
        body: { intent: "approval_required" },
      },
    );

    expect(response.status).toBe(202);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(provider.deliveries).toEqual([
      {
        target: {
          provider: "fcm",
          kind: "fid",
          value: "stored-firebase-target",
        },
        message: {
          title: "Yep Anywhere",
          body: "Open Yep Anywhere for an update.",
          intent: "approval_required",
          subscriptionId: subscription.subscriptionId,
        },
      },
    ]);
  });

  it("does not permit a send request to select a target or descriptive text", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider);
    const installation = await createInstallation(broker, "stored-target");
    const subscription = await createSubscription(broker, installation);

    const response = await brokerFetch(
      broker,
      `/v1/subscriptions/${subscription.subscriptionId}/notifications`,
      {
        method: "POST",
        secret: subscription.sendSecret,
        body: {
          intent: "approval_required",
          target: "attacker-selected-target",
          title: "private text",
        },
      },
    );

    expect(response.status).toBe(400);
    expect(provider.deliveries).toHaveLength(0);
  });

  it("replaces a target only with the installation capability", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider);
    const installation = await createInstallation(broker, "first-target");
    const subscription = await createSubscription(broker, installation);

    const unauthorized = await brokerFetch(
      broker,
      `/v1/installations/${installation.installationId}/target`,
      {
        method: "PUT",
        secret: generateSecret(),
        body: installationBody("unauthorized-target"),
      },
    );
    expect(unauthorized.status).toBe(404);

    const updated = await brokerFetch(
      broker,
      `/v1/installations/${installation.installationId}/target`,
      {
        method: "PUT",
        secret: installation.installationSecret,
        body: installationBody("replacement-target"),
      },
    );
    expect(updated.status).toBe(204);

    await brokerFetch(
      broker,
      `/v1/subscriptions/${subscription.subscriptionId}/notifications`,
      {
        method: "POST",
        secret: subscription.sendSecret,
        body: { intent: "session_completed" },
      },
    );
    expect(provider.deliveries[0]?.target.value).toBe("replacement-target");
  });

  it("returns one failure shape for unknown, wrong, and revoked capabilities", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider);
    const installation = await createInstallation(broker, "target");
    const subscription = await createSubscription(broker, installation);
    const notification = { intent: "input_required" };

    const wrong = await brokerFetch(
      broker,
      `/v1/subscriptions/${subscription.subscriptionId}/notifications`,
      {
        method: "POST",
        secret: generateSecret(),
        body: notification,
      },
    );
    const unknown = await brokerFetch(
      broker,
      `/v1/subscriptions/${generateOpaqueId()}/notifications`,
      {
        method: "POST",
        secret: generateSecret(),
        body: notification,
      },
    );

    const revoke = await brokerFetch(
      broker,
      `/v1/installations/${installation.installationId}/subscriptions/${subscription.subscriptionId}`,
      {
        method: "DELETE",
        secret: installation.installationSecret,
      },
    );
    expect(revoke.status).toBe(204);
    const revoked = await brokerFetch(
      broker,
      `/v1/subscriptions/${subscription.subscriptionId}/notifications`,
      {
        method: "POST",
        secret: subscription.sendSecret,
        body: notification,
      },
    );

    expect(wrong.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(revoked.status).toBe(404);
    const wrongBody = await wrong.json();
    const unknownBody = await unknown.json();
    const revokedBody = await revoked.json();
    expect(wrongBody).toEqual(unknownBody);
    expect(unknownBody).toEqual(revokedBody);
  });

  it("deletes an installation and its subscriptions", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider);
    const installation = await createInstallation(broker, "target");
    const subscription = await createSubscription(broker, installation);

    const deleted = await brokerFetch(
      broker,
      `/v1/installations/${installation.installationId}`,
      {
        method: "DELETE",
        secret: installation.installationSecret,
      },
    );
    expect(deleted.status).toBe(204);

    const send = await brokerFetch(
      broker,
      `/v1/subscriptions/${subscription.subscriptionId}/notifications`,
      {
        method: "POST",
        secret: subscription.sendSecret,
        body: { intent: "session_failed" },
      },
    );
    expect(send.status).toBe(404);
    expect(broker.repository.countInstallations()).toBe(0);
    expect(broker.repository.countActiveSubscriptions()).toBe(0);
  });

  it("does not let one installation revoke another installation's subscription", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider);
    const firstInstallation = await createInstallation(broker, "first-target");
    const secondInstallation = await createInstallation(
      broker,
      "second-target",
    );
    const secondSubscription = await createSubscription(
      broker,
      secondInstallation,
    );

    const response = await brokerFetch(
      broker,
      `/v1/installations/${firstInstallation.installationId}/subscriptions/${secondSubscription.subscriptionId}`,
      {
        method: "DELETE",
        secret: firstInstallation.installationSecret,
      },
    );

    expect(response.status).toBe(404);
    expect((await sendNotification(broker, secondSubscription)).status).toBe(
      202,
    );
  });

  it("maps provider failure classes without exposing provider details", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider);
    const installation = await createInstallation(broker, "target");
    const subscription = await createSubscription(broker, installation);

    provider.enqueueResult({ status: "retryable_failure" });
    const retryable = await sendNotification(broker, subscription);
    expect(retryable.status).toBe(503);
    expect(retryable.headers.get("retry-after")).toBe("30");

    provider.enqueueResult({ status: "invalid_target" });
    const rejected = await sendNotification(broker, subscription);
    expect(rejected.status).toBe(502);
    expect(await rejected.json()).toEqual({
      error: {
        code: "delivery_rejected",
        message: "Push provider rejected the notification",
      },
    });
  });

  it("bounds a provider call that does not settle", async () => {
    broker = await createPushBrokerServer({
      provider: new HangingProvider(),
      inMemoryDb: true,
      providerTimeoutMs: 5,
    });
    const installation = await createInstallation(broker, "target");
    const subscription = await createSubscription(broker, installation);

    const response = await sendNotification(broker, subscription);

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("30");
  });

  it("enforces JSON media type and body size", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider);
    const baseUrl = brokerUrl(broker);

    const wrongType = await fetch(`${baseUrl}/v1/installations`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "{}",
    });
    expect(wrongType.status).toBe(415);

    const oversized = await fetch(`${baseUrl}/v1/installations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ padding: "x".repeat(9_000) }),
    });
    expect(oversized.status).toBe(413);

    const malformed = await fetch(`${baseUrl}/v1/installations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(malformed.status).toBe(400);
  });

  it("applies registration and subscription send limits", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider, {
      registrationsPerHourPerIp: 1,
      sendsPerMinutePerSubscription: 1,
    });
    const installation = await createInstallation(broker, "target");

    const secondRegistration = await brokerFetch(broker, "/v1/installations", {
      method: "POST",
      body: installationBody("second-target"),
    });
    expect(secondRegistration.status).toBe(429);
    expect(secondRegistration.headers.get("retry-after")).not.toBeNull();

    const subscription = await createSubscription(broker, installation);
    expect((await sendNotification(broker, subscription)).status).toBe(202);
    expect((await sendNotification(broker, subscription)).status).toBe(429);
    expect(provider.deliveries).toHaveLength(1);
  });

  it("applies the installation-wide send limit across subscriptions", async () => {
    const provider = new FakePushProvider();
    broker = await startBroker(provider, {
      sendsPerMinutePerInstallation: 1,
      sendsPerMinutePerSubscription: 10,
    });
    const installation = await createInstallation(broker, "target");
    const first = await createSubscription(broker, installation);
    const second = await createSubscription(broker, installation);

    expect((await sendNotification(broker, first)).status).toBe(202);
    expect((await sendNotification(broker, second)).status).toBe(429);
    expect(provider.deliveries).toHaveLength(1);
  });

  it("returns conflict when an installation reaches its subscription cap", async () => {
    const provider = new FakePushProvider();
    broker = await createPushBrokerServer({
      provider,
      inMemoryDb: true,
      repository: { maxSubscriptionsPerInstallation: 1 },
    });
    const installation = await createInstallation(broker, "target");
    await createSubscription(broker, installation);

    const response = await brokerFetch(
      broker,
      `/v1/installations/${installation.installationId}/subscriptions`,
      {
        method: "POST",
        secret: installation.installationSecret,
      },
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "subscription_limit_reached" },
    });
  });

  it("keeps secrets, targets, and notification bodies out of error logs", async () => {
    const chunks: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString());
        callback();
      },
    });
    const logger = pino({ level: "error" }, stream);
    const provider = new ThrowingProvider();
    broker = await createPushBrokerServer({
      provider,
      inMemoryDb: true,
      logger,
    });
    const target = "sensitive-provider-target";
    const installation = await createInstallation(broker, target);
    const subscription = await createSubscription(broker, installation);

    const response = await sendNotification(broker, subscription);
    expect(response.status).toBe(502);

    const output = chunks.join("");
    expect(output).not.toContain(target);
    expect(output).not.toContain(installation.installationSecret);
    expect(output).not.toContain(subscription.sendSecret);
    expect(output).not.toContain("Open Yep Anywhere for an update.");
  });

  it("serves a minimal health response and closes cleanly", async () => {
    broker = await startBroker(new FakePushProvider());

    const response = await fetch(`${brokerUrl(broker)}/health`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ok" });

    const closing = broker;
    broker = undefined;
    await expect(closing.close()).resolves.toBeUndefined();
    await expect(closing.close()).resolves.toBeUndefined();
  });
});

class ThrowingProvider implements PushProvider {
  readonly name = "throwing-test-provider";

  async send(delivery: PushDelivery): Promise<never> {
    throw new Error(
      `${delivery.target.value}:${delivery.message.title}:${delivery.message.body}`,
    );
  }
}

class HangingProvider implements PushProvider {
  readonly name = "hanging-test-provider";

  async send(): Promise<never> {
    return new Promise<never>(() => {});
  }
}

async function startBroker(
  provider: PushProvider,
  rateLimits: Partial<BrokerRateLimitOptions> = {},
): Promise<PushBrokerServer> {
  return createPushBrokerServer({
    provider,
    inMemoryDb: true,
    rateLimits,
  });
}

async function createInstallation(
  broker: PushBrokerServer,
  targetValue: string,
): Promise<InstallationCredentials> {
  const response = await brokerFetch(broker, "/v1/installations", {
    method: "POST",
    body: installationBody(targetValue),
  });
  expect(response.status).toBe(201);
  return (await response.json()) as InstallationCredentials;
}

async function createSubscription(
  broker: PushBrokerServer,
  installation: InstallationCredentials,
): Promise<SubscriptionCredentials> {
  const response = await brokerFetch(
    broker,
    `/v1/installations/${installation.installationId}/subscriptions`,
    {
      method: "POST",
      secret: installation.installationSecret,
    },
  );
  expect(response.status).toBe(201);
  return (await response.json()) as SubscriptionCredentials;
}

function sendNotification(
  broker: PushBrokerServer,
  subscription: SubscriptionCredentials,
): Promise<Response> {
  return brokerFetch(
    broker,
    `/v1/subscriptions/${subscription.subscriptionId}/notifications`,
    {
      method: "POST",
      secret: subscription.sendSecret,
      body: { intent: "approval_required" },
    },
  );
}

function installationBody(targetValue: string) {
  return {
    target: {
      provider: "fcm",
      kind: "fid",
      value: targetValue,
    },
  };
}

function brokerFetch(
  broker: PushBrokerServer,
  path: string,
  options: {
    method: "POST" | "PUT" | "DELETE";
    secret?: string;
    body?: unknown;
  },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (options.secret) {
    headers.Authorization = `Bearer ${options.secret}`;
  }
  const init: RequestInit = {
    method: options.method,
    headers,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  return fetch(`${brokerUrl(broker)}${path}`, init);
}

function brokerUrl(broker: PushBrokerServer): string {
  return `http://127.0.0.1:${broker.port}`;
}
