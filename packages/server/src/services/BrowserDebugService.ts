import {
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

export const BROWSER_DEBUG_LEASE_TTL_MS = 30 * 60 * 1000;
export const BROWSER_DEBUG_MAX_ACTIVE_LEASES = 32;
export const BROWSER_DEBUG_MAX_EVENTS_PER_LEASE = 1_000;
export const BROWSER_DEBUG_MAX_EVENT_BYTES_PER_LEASE = 2 * 1024 * 1024;
export const BROWSER_DEBUG_MAX_EVAL_BYTES = 128 * 1024;
export const BROWSER_DEBUG_AGENT_URL_ENV = "YEP_BROWSER_DEBUG_AGENT_URL";
export const BROWSER_DEBUG_CALLER_TOKEN_ENV = "YEP_BROWSER_DEBUG_CALLER_TOKEN";

const MAX_POLL_MS = 20_000;
const MAX_EVAL_WAIT_MS = 60_000;

export interface BrowserDebugLeaseDescriptor {
  leaseId: string;
  controllerToken: string;
  grantUrl: string;
  sessionId: string;
  tabId: string;
  expiresAt: string;
}

export interface BrowserDebugEventInput {
  timestamp: number;
  kind: string;
  data?: unknown;
}

export interface BrowserDebugEvent extends BrowserDebugEventInput {
  sequence: number;
}

export interface BrowserDebugCommand {
  commandId: string;
  kind: "eval";
  code: string;
}

export interface BrowserDebugEvalResult {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface PendingEvaluation {
  command: BrowserDebugCommand;
  resolve: (result: BrowserDebugEvalResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface PollWaiter {
  resolve: (command: BrowserDebugCommand | null) => void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

interface BrowserDebugLease {
  leaseId: string;
  sessionId: string;
  tabId: string;
  controllerHash: Buffer;
  grantHash: Buffer;
  expiresAtMs: number;
  nextSequence: number;
  eventBytes: number;
  events: BrowserDebugEvent[];
  queuedCommand?: BrowserDebugCommand;
  pendingEvaluation?: PendingEvaluation;
  pollWaiter?: PollWaiter;
}

export class BrowserDebugError extends Error {
  constructor(
    public readonly status: 400 | 401 | 404 | 409 | 410 | 413 | 429 | 504,
    message: string,
  ) {
    super(message);
    this.name = "BrowserDebugError";
  }
}

function hashSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function secretsMatch(candidate: string, expected: Buffer): boolean {
  return timingSafeEqual(hashSecret(candidate), expected);
}

function randomSecret(): string {
  return randomBytes(32).toString("base64url");
}

export function createBrowserDebugCallerToken(
  providerRuntimeToken?: string,
): string {
  const runtimeToken = providerRuntimeToken?.trim();
  if (!runtimeToken) return randomSecret();
  return createHmac("sha256", runtimeToken)
    .update("yep-anywhere/browser-debug/caller/v1", "utf8")
    .digest("base64url");
}

function eventByteLength(event: BrowserDebugEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

export class BrowserDebugService {
  readonly callerToken: string;
  private readonly callerTokenHash: Buffer;
  private readonly leases = new Map<string, BrowserDebugLease>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxActiveLeases = BROWSER_DEBUG_MAX_ACTIVE_LEASES,
    callerToken = createBrowserDebugCallerToken(),
  ) {
    this.callerToken = callerToken;
    this.callerTokenHash = hashSecret(callerToken);
  }

  getAgentEnvironment(
    baseUrl: string,
    caCertificate?: string,
  ): Record<string, string> {
    const agentUrl = new URL(`${baseUrl.replace(/\/$/u, "")}/browser-debug/v1`);
    if (caCertificate) {
      agentUrl.hash = new URLSearchParams({
        "ya-ca": Buffer.from(caCertificate, "utf8").toString("base64url"),
      }).toString();
    }
    return {
      [BROWSER_DEBUG_AGENT_URL_ENV]: agentUrl.toString(),
      [BROWSER_DEBUG_CALLER_TOKEN_ENV]: this.callerToken,
    };
  }

  authorizeCaller(candidate: string): void {
    if (!candidate || !secretsMatch(candidate, this.callerTokenHash)) {
      throw new BrowserDebugError(401, "Browser diagnostics caller denied");
    }
  }

  createLease(sessionId: string, tabId: string): BrowserDebugLeaseDescriptor {
    this.sweepExpired();
    if (this.leases.size >= this.maxActiveLeases) {
      throw new BrowserDebugError(
        429,
        "Too many active browser diagnostic leases",
      );
    }
    if (!sessionId.trim() || sessionId.length > 256) {
      throw new BrowserDebugError(400, "Invalid browser diagnostic session ID");
    }
    if (!tabId.trim() || tabId.length > 128) {
      throw new BrowserDebugError(400, "Invalid browser diagnostic tab ID");
    }

    const leaseId = randomUUID();
    const controllerToken = randomSecret();
    const grantSecret = randomSecret();
    const expiresAtMs = this.now() + BROWSER_DEBUG_LEASE_TTL_MS;
    this.leases.set(leaseId, {
      leaseId,
      sessionId,
      tabId,
      controllerHash: hashSecret(controllerToken),
      grantHash: hashSecret(grantSecret),
      expiresAtMs,
      nextSequence: 1,
      eventBytes: 0,
      events: [],
    });
    return {
      leaseId,
      controllerToken,
      grantUrl: `yep-browser-debug://${leaseId}?grant=${grantSecret}`,
      sessionId,
      tabId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  getLeaseInfo(leaseId: string, grantSecret: string) {
    const lease = this.authorizeGrant(leaseId, grantSecret);
    return {
      leaseId: lease.leaseId,
      sessionId: lease.sessionId,
      tabId: lease.tabId,
      expiresAt: new Date(lease.expiresAtMs).toISOString(),
      eventCount: lease.events.length,
      latestSequence: lease.nextSequence - 1,
      evaluationPending: Boolean(lease.pendingEvaluation),
    };
  }

  appendEvents(
    leaseId: string,
    controllerToken: string,
    inputs: readonly BrowserDebugEventInput[],
  ): void {
    const lease = this.authorizeController(leaseId, controllerToken);
    for (const input of inputs) {
      const event: BrowserDebugEvent = {
        sequence: lease.nextSequence++,
        timestamp: input.timestamp,
        kind: input.kind,
        ...(input.data === undefined ? {} : { data: input.data }),
      };
      const bytes = eventByteLength(event);
      if (bytes > BROWSER_DEBUG_MAX_EVENT_BYTES_PER_LEASE) continue;
      lease.events.push(event);
      lease.eventBytes += bytes;
      while (
        lease.events.length > BROWSER_DEBUG_MAX_EVENTS_PER_LEASE ||
        lease.eventBytes > BROWSER_DEBUG_MAX_EVENT_BYTES_PER_LEASE
      ) {
        const removed = lease.events.shift();
        if (removed) lease.eventBytes -= eventByteLength(removed);
      }
    }
  }

  readEvents(
    leaseId: string,
    grantSecret: string,
    afterSequence: number,
  ): BrowserDebugEvent[] {
    const lease = this.authorizeGrant(leaseId, grantSecret);
    return lease.events.filter((event) => event.sequence > afterSequence);
  }

  async poll(
    leaseId: string,
    controllerToken: string,
    waitMs = MAX_POLL_MS,
    signal?: AbortSignal,
  ): Promise<BrowserDebugCommand | null> {
    const lease = this.authorizeController(leaseId, controllerToken);
    if (lease.queuedCommand) {
      const command = lease.queuedCommand;
      lease.queuedCommand = undefined;
      return command;
    }
    if (lease.pollWaiter) {
      throw new BrowserDebugError(
        409,
        "A browser diagnostic poll is already active",
      );
    }
    const boundedWaitMs = Math.max(
      0,
      Math.min(waitMs, MAX_POLL_MS, lease.expiresAtMs - this.now()),
    );
    if (boundedWaitMs === 0 || signal?.aborted) return null;
    return await new Promise<BrowserDebugCommand | null>((resolve) => {
      const waiter: PollWaiter = {
        resolve,
        timeout: setTimeout(() => {
          if (lease.pollWaiter === waiter) {
            this.resolvePollWaiter(lease, null);
          }
        }, boundedWaitMs),
        ...(signal ? { signal } : {}),
      };
      waiter.timeout.unref?.();
      if (signal) {
        waiter.abortHandler = () => {
          if (lease.pollWaiter === waiter) {
            this.resolvePollWaiter(lease, null);
          }
        };
        signal.addEventListener("abort", waiter.abortHandler, { once: true });
      }
      lease.pollWaiter = waiter;
      if (signal?.aborted) waiter.abortHandler?.();
    });
  }

  evaluate(
    leaseId: string,
    grantSecret: string,
    code: string,
    timeoutMs = MAX_EVAL_WAIT_MS,
  ): Promise<BrowserDebugEvalResult> {
    const lease = this.authorizeGrant(leaseId, grantSecret);
    if (lease.pendingEvaluation) {
      throw new BrowserDebugError(
        409,
        "A browser evaluation is already pending",
      );
    }
    if (
      !code ||
      Buffer.byteLength(code, "utf8") > BROWSER_DEBUG_MAX_EVAL_BYTES
    ) {
      throw new BrowserDebugError(
        413,
        "Browser evaluation exceeds the size limit",
      );
    }
    const command: BrowserDebugCommand = {
      commandId: randomUUID(),
      kind: "eval",
      code,
    };
    return new Promise<BrowserDebugEvalResult>((resolve, reject) => {
      const boundedWaitMs = Math.max(1, Math.min(timeoutMs, MAX_EVAL_WAIT_MS));
      const timeout = setTimeout(() => {
        if (lease.pendingEvaluation?.command.commandId !== command.commandId) {
          return;
        }
        lease.pendingEvaluation = undefined;
        if (lease.queuedCommand?.commandId === command.commandId) {
          lease.queuedCommand = undefined;
        }
        reject(new BrowserDebugError(504, "Browser evaluation timed out"));
      }, boundedWaitMs);
      timeout.unref?.();
      lease.pendingEvaluation = { command, resolve, reject, timeout };
      if (lease.pollWaiter) {
        this.resolvePollWaiter(lease, command);
      } else {
        lease.queuedCommand = command;
      }
    });
  }

  submitResult(
    leaseId: string,
    controllerToken: string,
    commandId: string,
    result: BrowserDebugEvalResult,
  ): void {
    const lease = this.authorizeController(leaseId, controllerToken);
    const pending = lease.pendingEvaluation;
    if (!pending || pending.command.commandId !== commandId) {
      throw new BrowserDebugError(
        404,
        "Browser diagnostic command is no longer pending",
      );
    }
    lease.pendingEvaluation = undefined;
    clearTimeout(pending.timeout);
    pending.resolve(result);
  }

  revoke(leaseId: string, controllerToken: string): void {
    const lease = this.authorizeController(leaseId, controllerToken);
    this.endLease(
      lease,
      new BrowserDebugError(410, "Browser diagnostic lease revoked"),
    );
  }

  private authorizeController(
    leaseId: string,
    controllerToken: string,
  ): BrowserDebugLease {
    const lease = this.requireLiveLease(leaseId);
    if (
      !controllerToken ||
      !secretsMatch(controllerToken, lease.controllerHash)
    ) {
      throw new BrowserDebugError(404, "Browser diagnostic lease not found");
    }
    return lease;
  }

  private authorizeGrant(
    leaseId: string,
    grantSecret: string,
  ): BrowserDebugLease {
    const lease = this.requireLiveLease(leaseId);
    if (!grantSecret || !secretsMatch(grantSecret, lease.grantHash)) {
      throw new BrowserDebugError(404, "Browser diagnostic lease not found");
    }
    return lease;
  }

  private requireLiveLease(leaseId: string): BrowserDebugLease {
    const lease = this.leases.get(leaseId);
    if (!lease) {
      throw new BrowserDebugError(404, "Browser diagnostic lease not found");
    }
    if (lease.expiresAtMs <= this.now()) {
      this.endLease(
        lease,
        new BrowserDebugError(410, "Browser diagnostic lease expired"),
      );
      throw new BrowserDebugError(410, "Browser diagnostic lease expired");
    }
    return lease;
  }

  private sweepExpired(): void {
    for (const lease of this.leases.values()) {
      if (lease.expiresAtMs <= this.now()) {
        this.endLease(
          lease,
          new BrowserDebugError(410, "Browser diagnostic lease expired"),
        );
      }
    }
  }

  private endLease(lease: BrowserDebugLease, error: Error): void {
    this.leases.delete(lease.leaseId);
    if (lease.pollWaiter) {
      this.resolvePollWaiter(lease, null);
    }
    if (lease.pendingEvaluation) {
      clearTimeout(lease.pendingEvaluation.timeout);
      lease.pendingEvaluation.reject(error);
      lease.pendingEvaluation = undefined;
    }
    lease.queuedCommand = undefined;
  }

  private resolvePollWaiter(
    lease: BrowserDebugLease,
    command: BrowserDebugCommand | null,
  ): void {
    const waiter = lease.pollWaiter;
    if (!waiter) return;
    lease.pollWaiter = undefined;
    clearTimeout(waiter.timeout);
    if (waiter.signal && waiter.abortHandler) {
      waiter.signal.removeEventListener("abort", waiter.abortHandler);
    }
    waiter.resolve(command);
  }
}
