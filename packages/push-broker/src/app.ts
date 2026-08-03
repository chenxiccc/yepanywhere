import type { HttpBindings } from "@hono/node-server";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import {
  type TrustedProxy,
  getClientIp,
} from "./client-ip.js";
import {
  isGeneratedSecret,
  isOpaqueId,
} from "./credentials.js";
import { FixedWindowRateLimiter } from "./rate-limiter.js";
import {
  type PushRepository,
  SubscriptionLimitError,
} from "./repository.js";
import type {
  PushDeliveryResult,
  PushIntent,
  PushProvider,
} from "./types.js";
import {
  parseInstallationBody,
  parseNotificationBody,
} from "./validation.js";

const MAX_JSON_BODY_BYTES = 8 * 1024;
const GENERIC_TITLE = "Yep Anywhere";
const GENERIC_BODY = "Open Yep Anywhere for an update.";
const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;

export interface BrokerRateLimitOptions {
  writeRequestsPerMinutePerIp: number;
  registrationsPerHourPerIp: number;
  sendsPerMinutePerSubscription: number;
  sendsPerMinutePerInstallation: number;
  maxEntries: number;
}

export const DEFAULT_BROKER_RATE_LIMITS: BrokerRateLimitOptions = {
  writeRequestsPerMinutePerIp: 120,
  registrationsPerHourPerIp: 10,
  sendsPerMinutePerSubscription: 30,
  sendsPerMinutePerInstallation: 120,
  maxEntries: 10_000,
};

interface BrokerBindings extends HttpBindings {}

interface BrokerVariables {
  clientIp: string;
}

type BrokerEnv = {
  Bindings: BrokerBindings;
  Variables: BrokerVariables;
};

export interface CreateBrokerAppOptions {
  repository: PushRepository;
  provider: PushProvider;
  logger: Logger;
  trustedProxies?: TrustedProxy[];
  rateLimits?: Partial<BrokerRateLimitOptions>;
  providerTimeoutMs?: number;
  now?: () => number;
}

export function createBrokerApp(options: CreateBrokerAppOptions): Hono<BrokerEnv> {
  const trustedProxies = options.trustedProxies ?? [];
  const providerTimeoutMs =
    options.providerTimeoutMs ?? DEFAULT_PROVIDER_TIMEOUT_MS;
  if (!Number.isInteger(providerTimeoutMs) || providerTimeoutMs < 1) {
    throw new Error("Provider timeout must be a positive integer");
  }
  const rateLimits = new BrokerRateLimits({
    ...DEFAULT_BROKER_RATE_LIMITS,
    ...options.rateLimits,
    now: options.now,
  });
  const app = new Hono<BrokerEnv>();

  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: MAX_JSON_BODY_BYTES,
      onError: (c) =>
        jsonError(c, 413, "body_too_large", "Request body is too large"),
    }),
  );

  app.use("/v1/*", async (c, next) => {
    const incoming = c.env.incoming;
    const clientIp = incoming
      ? getClientIp(incoming, trustedProxies)
      : "unknown";
    c.set("clientIp", clientIp);

    if (isMutation(c.req.method)) {
      const limited = rateLimitResponse(
        c,
        rateLimits.writeByIp.consume(clientIp),
      );
      if (limited) return limited;
    }

    return next();
  });

  app.get("/health", (c) => {
    options.repository.countInstallations();
    return c.json({ status: "ok" });
  });

  app.post("/v1/installations", async (c) => {
    const registrationLimited = rateLimitResponse(
      c,
      rateLimits.registrationByIp.consume(c.get("clientIp")),
    );
    if (registrationLimited) return registrationLimited;

    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = parseInstallationBody(body.value);
    if (!parsed) {
      return jsonError(
        c,
        400,
        "invalid_installation",
        "Installation request is invalid",
      );
    }

    const credentials = options.repository.createInstallation(parsed.target);
    return c.json(credentials, 201);
  });

  app.put("/v1/installations/:installationId/target", async (c) => {
    const authenticated = authenticateInstallation(c, options.repository);
    if (!authenticated) return capabilityNotFound(c);

    const body = await readJsonBody(c);
    if (!body.ok) return body.response;
    const parsed = parseInstallationBody(body.value);
    if (!parsed) {
      return jsonError(c, 400, "invalid_target", "Push target is invalid");
    }

    // Recheck after the awaited body read so revocation during upload cannot
    // authorize a target mutation from an earlier credential snapshot.
    const currentInstallation = options.repository.authenticateInstallation(
      authenticated.installation.id,
      authenticated.secret,
    );
    if (!currentInstallation) return capabilityNotFound(c);

    if (
      !options.repository.updateInstallationTarget(
        currentInstallation.id,
        parsed.target,
      )
    ) {
      return capabilityNotFound(c);
    }
    return c.body(null, 204);
  });

  app.delete("/v1/installations/:installationId", (c) => {
    const authenticated = authenticateInstallation(c, options.repository);
    if (!authenticated) return capabilityNotFound(c);

    options.repository.deleteInstallation(authenticated.installation.id);
    return c.body(null, 204);
  });

  app.post(
    "/v1/installations/:installationId/subscriptions",
    (c) => {
      const authenticated = authenticateInstallation(
        c,
        options.repository,
      );
      if (!authenticated) return capabilityNotFound(c);

      try {
        const credentials = options.repository.createSubscription(
          authenticated.installation.id,
        );
        return c.json(credentials, 201);
      } catch (error) {
        if (error instanceof SubscriptionLimitError) {
          return jsonError(
            c,
            409,
            "subscription_limit_reached",
            "Installation subscription limit reached",
          );
        }
        throw error;
      }
    },
  );

  app.delete(
    "/v1/installations/:installationId/subscriptions/:subscriptionId",
    (c) => {
      const authenticated = authenticateInstallation(
        c,
        options.repository,
      );
      const subscriptionId = c.req.param("subscriptionId");
      if (
        !authenticated ||
        !isOpaqueId(subscriptionId) ||
        !options.repository.revokeSubscription(
          authenticated.installation.id,
          subscriptionId,
        )
      ) {
        return capabilityNotFound(c);
      }

      return c.body(null, 204);
    },
  );

  app.post(
    "/v1/subscriptions/:subscriptionId/notifications",
    async (c) => {
      const subscriptionId = c.req.param("subscriptionId");
      const sendSecret = readBearerSecret(c);
      if (!isOpaqueId(subscriptionId) || !sendSecret) {
        return capabilityNotFound(c);
      }

      const subscription = options.repository.authenticateSubscription(
        subscriptionId,
        sendSecret,
      );
      if (!subscription) return capabilityNotFound(c);

      const subscriptionLimited = rateLimitResponse(
        c,
        rateLimits.sendBySubscription.consume(subscription.id),
      );
      if (subscriptionLimited) return subscriptionLimited;

      const installationLimited = rateLimitResponse(
        c,
        rateLimits.sendByInstallation.consume(subscription.installationId),
      );
      if (installationLimited) return installationLimited;

      const body = await readJsonBody(c);
      if (!body.ok) return body.response;
      const parsed = parseNotificationBody(body.value);
      if (!parsed) {
        return jsonError(
          c,
          400,
          "invalid_notification",
          "Notification request is invalid",
        );
      }

      // The first authentication supplies stable rate-limit keys. Recheck
      // after reading the body so a concurrently revoked send capability
      // cannot reach the provider.
      const currentSubscription =
        options.repository.authenticateSubscription(
          subscriptionId,
          sendSecret,
        );
      if (!currentSubscription) return capabilityNotFound(c);

      let result: PushDeliveryResult;
      try {
        result = await sendWithTimeout(
          options.provider,
          {
            target: currentSubscription.target,
            message: buildGenericMessage(
              currentSubscription.id,
              parsed.intent,
            ),
          },
          providerTimeoutMs,
        );
      } catch {
        options.logger.error(
          { provider: options.provider.name },
          "Push provider threw unexpectedly",
        );
        result = { status: "rejected" };
      }

      if (result.status === "accepted") {
        options.repository.touchSubscription(subscription.id);
        return c.json({ accepted: true }, 202);
      }
      if (result.status === "retryable_failure") {
        c.header("Retry-After", "30");
        return jsonError(
          c,
          503,
          "provider_unavailable",
          "Push provider is temporarily unavailable",
        );
      }
      return jsonError(
        c,
        502,
        "delivery_rejected",
        "Push provider rejected the notification",
      );
    },
  );

  app.notFound((c) =>
    jsonError(c, 404, "not_found", "Resource was not found"),
  );

  app.onError((error, c) => {
    options.logger.error(
      {
        errorName: error.name,
        provider: options.provider.name,
      },
      "Unhandled push broker request error",
    );
    return jsonError(c, 500, "internal_error", "Internal server error");
  });

  return app;
}

class BrokerRateLimits {
  readonly writeByIp: FixedWindowRateLimiter;
  readonly registrationByIp: FixedWindowRateLimiter;
  readonly sendBySubscription: FixedWindowRateLimiter;
  readonly sendByInstallation: FixedWindowRateLimiter;

  constructor(
    options: BrokerRateLimitOptions & { now?: () => number },
  ) {
    const shared = {
      maxEntries: options.maxEntries,
      now: options.now,
    };
    this.writeByIp = new FixedWindowRateLimiter({
      ...shared,
      limit: options.writeRequestsPerMinutePerIp,
      windowMs: 60_000,
    });
    this.registrationByIp = new FixedWindowRateLimiter({
      ...shared,
      limit: options.registrationsPerHourPerIp,
      windowMs: 60 * 60_000,
    });
    this.sendBySubscription = new FixedWindowRateLimiter({
      ...shared,
      limit: options.sendsPerMinutePerSubscription,
      windowMs: 60_000,
    });
    this.sendByInstallation = new FixedWindowRateLimiter({
      ...shared,
      limit: options.sendsPerMinutePerInstallation,
      windowMs: 60_000,
    });
  }
}

function authenticateInstallation(
  c: Context<BrokerEnv>,
  repository: PushRepository,
) {
  const installationId = c.req.param("installationId");
  const installationSecret = readBearerSecret(c);
  if (
    typeof installationId !== "string" ||
    !isOpaqueId(installationId) ||
    !installationSecret
  ) {
    return undefined;
  }
  const installation = repository.authenticateInstallation(
    installationId,
    installationSecret,
  );
  return installation
    ? { installation, secret: installationSecret }
    : undefined;
}

function readBearerSecret(c: Context<BrokerEnv>): string | undefined {
  const authorization = c.req.header("authorization");
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? "");
  const secret = match?.[1];
  return secret && isGeneratedSecret(secret) ? secret : undefined;
}

async function readJsonBody(
  c: Context<BrokerEnv>,
): Promise<
  { ok: true; value: unknown } | { ok: false; response: Response }
> {
  const contentType = c.req.header("content-type")?.toLowerCase() ?? "";
  if (!/^application\/json(?:\s*;|$)/.test(contentType)) {
    return {
      ok: false,
      response: jsonError(
        c,
        415,
        "json_required",
        "Content-Type must be application/json",
      ),
    };
  }

  try {
    return { ok: true, value: await c.req.json() };
  } catch {
    return {
      ok: false,
      response: jsonError(
        c,
        400,
        "invalid_json",
        "Request body is not valid JSON",
      ),
    };
  }
}

function buildGenericMessage(
  subscriptionId: string,
  intent: PushIntent,
) {
  return {
    title: GENERIC_TITLE,
    body: GENERIC_BODY,
    intent,
    subscriptionId,
  };
}

function capabilityNotFound(c: Context<BrokerEnv>): Response {
  return jsonError(c, 404, "capability_not_found", "Capability was not found");
}

function rateLimitResponse(
  c: Context<BrokerEnv>,
  result: { allowed: boolean; retryAfterSeconds: number },
): Response | undefined {
  if (result.allowed) return undefined;
  c.header("Retry-After", String(result.retryAfterSeconds));
  return jsonError(c, 429, "rate_limited", "Rate limit exceeded");
}

function jsonError(
  c: Context,
  status: 400 | 404 | 409 | 413 | 415 | 429 | 500 | 502 | 503,
  code: string,
  message: string,
): Response {
  return c.json({ error: { code, message } }, status);
}

function isMutation(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "DELETE";
}

async function sendWithTimeout(
  provider: PushProvider,
  delivery: Parameters<PushProvider["send"]>[0],
  timeoutMs: number,
): Promise<PushDeliveryResult> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      provider.send(delivery),
      new Promise<PushDeliveryResult>((resolve) => {
        timeout = setTimeout(
          () => resolve({ status: "retryable_failure" }),
          timeoutMs,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}
