import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createLruMap, refreshLruMap } from "../lib/lruCollections.js";
import { getLogger } from "../logging/logger.js";

export const SESSION_WAKE_TEXT_MAX_CHARS = 2_000;
const DEFAULT_BURST = 3;
const DEFAULT_REFILL_MS = 60_000;
const DEFAULT_MAX_TRACKED_SESSIONS = 4_096;
const SECRET_BYTES = 32;
const SECRET_FILE = "session-wake-secret";

export interface SessionWakeRequest {
  sessionId: string;
  text: string;
  source?: string;
  jobId?: string;
}

export type SessionWakeDeliveryResult =
  | { accepted: true }
  | {
      accepted: false;
      status: 404 | 409 | 503;
      error: string;
    };

interface RateBucket {
  tokens: number;
  updatedAt: number;
}

export interface SessionWakeServiceOptions {
  secret: Uint8Array;
  isEnabled: (sessionId: string) => boolean;
  deliver: (request: SessionWakeRequest) => Promise<SessionWakeDeliveryResult>;
  logger?: SessionWakeLogger;
  now?: () => number;
  burst?: number;
  refillMs?: number;
  maxTrackedSessions?: number;
}

export interface SessionWakeLogger {
  warn(bindings: Record<string, unknown>, message: string): void;
  error(bindings: Record<string, unknown>, message: string): void;
}

export type SessionWakeAcceptance =
  | { status: 202 }
  | { status: 401 | 403 | 429; error: string }
  | Exclude<SessionWakeDeliveryResult, { accepted: true }>;

const log = getLogger().child({ component: "session-wake" });

export class SessionWakeService {
  private readonly secret: Buffer;
  private readonly isEnabled: SessionWakeServiceOptions["isEnabled"];
  private readonly deliver: SessionWakeServiceOptions["deliver"];
  private readonly logger: SessionWakeLogger;
  private readonly now: () => number;
  private readonly burst: number;
  private readonly refillMs: number;
  private readonly maxTrackedSessions: number;
  private readonly buckets = createLruMap<string, RateBucket>();

  constructor(options: SessionWakeServiceOptions) {
    if (options.secret.byteLength < SECRET_BYTES) {
      throw new Error("Session wake secret must contain at least 32 bytes");
    }
    this.secret = Buffer.from(options.secret);
    this.isEnabled = options.isEnabled;
    this.deliver = options.deliver;
    this.logger = options.logger ?? log;
    this.now = options.now ?? Date.now;
    this.burst = options.burst ?? DEFAULT_BURST;
    this.refillMs = options.refillMs ?? DEFAULT_REFILL_MS;
    this.maxTrackedSessions =
      options.maxTrackedSessions ?? DEFAULT_MAX_TRACKED_SESSIONS;
  }

  tokenForSession(sessionId: string): string {
    return createHmac("sha256", this.secret)
      .update("yep-anywhere/session-wake/v1\0")
      .update(sessionId)
      .digest("base64url");
  }

  environmentForSession(
    sessionId: string,
    baseUrl: string,
  ): Record<string, string> {
    const url = new URL(
      `session-wake/${encodeURIComponent(sessionId)}`,
      baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
    );
    return {
      YEP_SESSION_WAKE_URL: url.toString(),
      YEP_SESSION_WAKE_TOKEN: this.tokenForSession(sessionId),
    };
  }

  async accept(
    sessionId: string,
    authorization: string | undefined,
    request: Omit<SessionWakeRequest, "sessionId">,
  ): Promise<SessionWakeAcceptance> {
    if (!this.isAuthorized(sessionId, authorization)) {
      return { status: 401, error: "Invalid session wake credentials" };
    }
    if (!this.isEnabled(sessionId)) {
      return { status: 403, error: "Session wake turns are disabled" };
    }
    if (!this.takeRateToken(sessionId)) {
      this.logger.warn({ sessionId }, "SESSION_WAKE: rate limit exceeded");
      return { status: 429, error: "Session wake rate limit exceeded" };
    }

    let result: SessionWakeDeliveryResult;
    try {
      result = await this.deliver({ sessionId, ...request });
    } catch (error) {
      this.logger.error(
        { err: error, sessionId },
        "SESSION_WAKE: delivery failed",
      );
      return {
        accepted: false,
        status: 503,
        error: "Session wake delivery failed",
      };
    }
    if (!result.accepted) {
      this.logger.warn(
        { sessionId, status: result.status },
        "SESSION_WAKE: delivery rejected",
      );
      return result;
    }
    return { status: 202 };
  }

  isAuthorized(sessionId: string, authorization: string | undefined): boolean {
    const prefix = "Bearer ";
    if (!authorization?.startsWith(prefix)) return false;
    const provided = Buffer.from(authorization.slice(prefix.length));
    const expected = Buffer.from(this.tokenForSession(sessionId));
    return (
      provided.length === expected.length && timingSafeEqual(provided, expected)
    );
  }

  private takeRateToken(sessionId: string): boolean {
    const now = this.now();
    const previous = this.buckets.get(sessionId);
    const elapsed = previous ? Math.max(0, now - previous.updatedAt) : 0;
    const available = previous
      ? Math.min(this.burst, previous.tokens + elapsed / this.refillMs)
      : this.burst;
    const accepted = available >= 1;
    refreshLruMap(this.buckets, sessionId, {
      tokens: accepted ? available - 1 : available,
      updatedAt: now,
    });
    while (this.buckets.size > this.maxTrackedSessions) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return accepted;
  }
}

export async function loadOrCreateSessionWakeSecret(
  dataDir: string,
): Promise<Buffer> {
  const filePath = path.join(dataDir, SECRET_FILE);
  await fs.mkdir(dataDir, { recursive: true });
  try {
    const existing = await fs.readFile(filePath);
    if (existing.byteLength < SECRET_BYTES) {
      throw new Error(`Invalid session wake secret at ${filePath}`);
    }
    await fs.chmod(filePath, 0o600);
    return existing;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const created = randomBytes(SECRET_BYTES);
  try {
    await fs.writeFile(filePath, created, { flag: "wx", mode: 0o600 });
    return created;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(filePath);
    if (existing.byteLength < SECRET_BYTES) {
      throw new Error(`Invalid session wake secret at ${filePath}`);
    }
    await fs.chmod(filePath, 0o600);
    return existing;
  }
}
