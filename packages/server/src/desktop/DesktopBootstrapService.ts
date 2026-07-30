import * as crypto from "node:crypto";

export const DESKTOP_BOOTSTRAP_PROTOCOL_VERSION = 1;
export const DESKTOP_SESSION_COOKIE_NAME = "yep-anywhere-desktop-session";

const DEFAULT_CODE_TTL_MS = 30_000;
const DEFAULT_MAX_ACTIVE_CODES = 16;
const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60_000;
const DEFAULT_MAX_ACTIVE_SESSIONS = 32;
const DEFAULT_MAX_INVALID_ATTEMPTS_PER_MINUTE = 30;

function timingSafeEqual(a: string, b: string): boolean {
  const left = crypto.createHash("sha256").update(a).digest();
  const right = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(left, right);
}

export interface DesktopBootstrapServiceOptions {
  masterSecret: string;
  codeTtlMs?: number;
  maxActiveCodes?: number;
  sessionTtlMs?: number;
  maxActiveSessions?: number;
  maxInvalidAttemptsPerMinute?: number;
  now?: () => number;
}

/**
 * In-memory authentication state shared only by the desktop supervisor and its
 * bundled server process. Codes and sessions intentionally die with the
 * process and are never persisted.
 */
export class DesktopBootstrapService {
  private readonly masterSecret: string;
  private readonly codeTtlMs: number;
  private readonly maxActiveCodes: number;
  private readonly sessionTtlMs: number;
  private readonly maxActiveSessions: number;
  private readonly maxInvalidAttemptsPerMinute: number;
  private readonly now: () => number;
  private readonly codes = new Map<string, number>();
  private readonly sessions = new Map<string, number>();
  private invalidAttemptWindowStartedAt = 0;
  private invalidAttempts = 0;

  constructor(options: DesktopBootstrapServiceOptions) {
    if (options.masterSecret.length < 32) {
      throw new Error("Desktop bootstrap master secret is too short");
    }
    this.masterSecret = options.masterSecret;
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CODE_TTL_MS;
    this.maxActiveCodes = options.maxActiveCodes ?? DEFAULT_MAX_ACTIVE_CODES;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
    this.maxActiveSessions =
      options.maxActiveSessions ?? DEFAULT_MAX_ACTIVE_SESSIONS;
    this.maxInvalidAttemptsPerMinute =
      options.maxInvalidAttemptsPerMinute ??
      DEFAULT_MAX_INVALID_ATTEMPTS_PER_MINUTE;
    this.now = options.now ?? Date.now;
  }

  validateMasterSecret(candidate: string | undefined): boolean {
    const valid = !!candidate && timingSafeEqual(candidate, this.masterSecret);
    if (!valid) this.recordInvalidAttempt();
    return valid;
  }

  mintCode(): { code: string; expiresInMs: number } {
    this.pruneExpiredCodes();
    while (this.codes.size >= this.maxActiveCodes) {
      const oldest = this.codes.keys().next().value;
      if (!oldest) break;
      this.codes.delete(oldest);
    }

    const code = crypto.randomBytes(32).toString("base64url");
    this.codes.set(code, this.now() + this.codeTtlMs);
    return { code, expiresInMs: this.codeTtlMs };
  }

  consumeCode(code: string): string | null {
    this.pruneExpiredCodes();
    const expiresAt = this.codes.get(code);
    if (expiresAt === undefined) {
      this.recordInvalidAttempt();
      return null;
    }

    this.codes.delete(code);
    if (expiresAt <= this.now()) {
      this.recordInvalidAttempt();
      return null;
    }

    this.pruneExpiredSessions();
    while (this.sessions.size >= this.maxActiveSessions) {
      const oldest = this.sessions.keys().next().value;
      if (!oldest) break;
      this.sessions.delete(oldest);
    }
    const session = crypto.randomBytes(32).toString("base64url");
    this.sessions.set(session, this.now() + this.sessionTtlMs);
    return session;
  }

  validateSession(session: string | undefined): boolean {
    if (!session) return false;
    this.pruneExpiredSessions();
    return this.sessions.has(session);
  }

  canAttemptBootstrap(): boolean {
    this.refreshInvalidAttemptWindow();
    return this.invalidAttempts < this.maxInvalidAttemptsPerMinute;
  }

  private pruneExpiredCodes(): void {
    const now = this.now();
    for (const [code, expiresAt] of this.codes) {
      if (expiresAt <= now) {
        this.codes.delete(code);
      }
    }
  }

  private pruneExpiredSessions(): void {
    const now = this.now();
    for (const [session, expiresAt] of this.sessions) {
      if (expiresAt <= now) {
        this.sessions.delete(session);
      }
    }
  }

  private refreshInvalidAttemptWindow(): void {
    const now = this.now();
    if (
      this.invalidAttemptWindowStartedAt === 0 ||
      now - this.invalidAttemptWindowStartedAt >= 60_000
    ) {
      this.invalidAttemptWindowStartedAt = now;
      this.invalidAttempts = 0;
    }
  }

  private recordInvalidAttempt(): void {
    this.refreshInvalidAttemptWindow();
    this.invalidAttempts += 1;
  }
}
