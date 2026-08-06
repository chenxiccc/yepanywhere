import { isNonRetryableError as isConnectionNonRetryableError } from "../connection/types";
import type { SourceTransport, StreamHandlers, Subscription } from "./types";
import { isSourceTransportError } from "./types";

export type ManagedStreamState =
  | "waiting"
  | "subscribing"
  | "open"
  | "retrying"
  | "terminal"
  | "closed";

export interface ManagedStreamEvent {
  readonly eventType: string;
  readonly eventId?: string;
  readonly data: unknown;
}

export interface ManagedStreamSnapshot {
  readonly state: ManagedStreamState;
  readonly connected: boolean;
  readonly terminal: boolean;
  readonly retryAttempt: number;
  readonly lastEventId?: string;
  readonly error?: Error;
}

export interface ManagedStreamSubscribeInput {
  readonly transport: SourceTransport;
  readonly handlers: StreamHandlers;
  readonly lastEventId?: string;
}

export interface ManagedStreamSpec {
  subscribe(input: ManagedStreamSubscribeInput): Subscription;
  onEvent(event: ManagedStreamEvent): void;
  onOpen?: () => void;
  onError?: (error: Error) => void;
  onClose?: (error?: Error) => void;
  captureEventId?: (event: ManagedStreamEvent) => string | undefined;
  isNonRetryableError?: (error: Error) => boolean;
}

export interface ManagedStreamScheduler {
  setTimeout(fn: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface ManagedStreamRetryOptions {
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly factor?: number;
}

export interface ManagedStreamOptions {
  readonly autoStart?: boolean;
  readonly retry?: ManagedStreamRetryOptions;
  readonly scheduler?: ManagedStreamScheduler;
}

export interface ManagedStream {
  getSnapshot(): ManagedStreamSnapshot;
  subscribe(listener: () => void): () => void;
  start(): void;
  restart(options?: { delayMs?: number }): void;
  close(): void;
}

const DEFAULT_RETRY_INITIAL_DELAY_MS = 250;
const DEFAULT_RETRY_MAX_DELAY_MS = 5_000;
const DEFAULT_RETRY_FACTOR = 2;

const defaultScheduler: ManagedStreamScheduler = {
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

export function createManagedStream(
  transport: SourceTransport,
  spec: ManagedStreamSpec,
  options: ManagedStreamOptions = {},
): ManagedStream {
  return new DefaultManagedStream(transport, spec, options);
}

class DefaultManagedStream implements ManagedStream {
  private readonly transport: SourceTransport;
  private readonly spec: ManagedStreamSpec;
  private readonly scheduler: ManagedStreamScheduler;
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retryFactor: number;
  private readonly listeners = new Set<() => void>();

  private snapshot: ManagedStreamSnapshot = {
    state: "waiting",
    connected: false,
    terminal: false,
    retryAttempt: 0,
  };
  private statusUnsubscribe: (() => void) | null = null;
  private activeSubscription: Subscription | null = null;
  private activeToken = 0;
  private retryTimer: unknown | null = null;
  private started = false;
  private closed = false;
  private terminal = false;
  private subscribing = false;

  constructor(
    transport: SourceTransport,
    spec: ManagedStreamSpec,
    options: ManagedStreamOptions,
  ) {
    this.transport = transport;
    this.spec = spec;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.retryInitialDelayMs =
      options.retry?.initialDelayMs ?? DEFAULT_RETRY_INITIAL_DELAY_MS;
    this.retryMaxDelayMs =
      options.retry?.maxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.retryFactor = options.retry?.factor ?? DEFAULT_RETRY_FACTOR;

    if (options.autoStart !== false) {
      this.start();
    }
  }

  getSnapshot(): ManagedStreamSnapshot {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(): void {
    if (this.started || this.closed || this.terminal) return;
    this.started = true;
    this.statusUnsubscribe = this.transport.status.subscribe(() => {
      this.handleTransportStatusChange();
    });
    this.trySubscribe();
  }

  restart(options: { delayMs?: number } = {}): void {
    if (this.closed || this.terminal) return;
    if (!this.started) {
      this.start();
      return;
    }
    this.clearRetryTimer();
    this.dropActiveSubscription({ close: true });
    const delayMs = options.delayMs ?? 0;
    this.setSnapshot({
      state: this.isTransportReady()
        ? delayMs > 0
          ? "retrying"
          : "subscribing"
        : "waiting",
      connected: false,
      error: undefined,
    });
    if (delayMs > 0) {
      this.retryTimer = this.scheduler.setTimeout(() => {
        this.retryTimer = null;
        this.trySubscribe();
      }, delayMs);
      return;
    }
    this.trySubscribe();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearRetryTimer();
    this.statusUnsubscribe?.();
    this.statusUnsubscribe = null;
    this.dropActiveSubscription({ close: true });
    this.setSnapshot({
      state: "closed",
      connected: false,
      terminal: false,
      error: undefined,
    });
  }

  private handleTransportStatusChange(): void {
    if (!this.started || this.closed || this.terminal) return;
    if (!this.isTransportReady()) {
      this.clearRetryTimer();
      this.dropActiveSubscription({ close: true });
      this.setSnapshot({
        state: "waiting",
        connected: false,
        error: undefined,
      });
      return;
    }
    if (
      !this.activeSubscription &&
      !this.subscribing &&
      this.retryTimer === null
    ) {
      this.trySubscribe();
    }
  }

  private trySubscribe(): void {
    if (
      !this.started ||
      this.closed ||
      this.terminal ||
      this.activeSubscription ||
      this.subscribing
    ) {
      return;
    }
    if (!this.isTransportReady()) {
      this.setSnapshot({
        state: "waiting",
        connected: false,
        error: undefined,
      });
      return;
    }

    const token = this.nextActiveToken();
    const handlers = this.createHandlers(token);
    this.subscribing = true;
    this.setSnapshot({
      state: "subscribing",
      connected: false,
      error: undefined,
    });

    try {
      const subscription = this.spec.subscribe({
        transport: this.transport,
        handlers,
        lastEventId: this.snapshot.lastEventId,
      });
      if (!this.isCurrentToken(token)) {
        subscription.close();
        return;
      }
      this.activeSubscription = subscription;
    } catch (error) {
      if (this.isCurrentToken(token)) {
        this.handleSubscriptionError(token, toError(error));
      }
    } finally {
      this.subscribing = false;
    }
  }

  private createHandlers(token: number): StreamHandlers {
    return {
      onEvent: (eventType, eventId, data) => {
        if (!this.isCurrentToken(token)) return;
        const event = { eventType, eventId, data };
        const capturedEventId = this.spec.captureEventId
          ? this.spec.captureEventId(event)
          : event.eventId;
        if (capturedEventId) {
          this.snapshot = {
            ...this.snapshot,
            lastEventId: capturedEventId,
          };
        }
        this.spec.onEvent(event);
      },
      onOpen: () => {
        if (!this.isCurrentToken(token)) return;
        this.clearRetryTimer();
        this.setSnapshot({
          state: "open",
          connected: true,
          retryAttempt: 0,
          error: undefined,
        });
        this.spec.onOpen?.();
      },
      onError: (error) => {
        this.handleSubscriptionError(token, error);
      },
      onClose: (error) => {
        this.handleSubscriptionClose(token, error);
      },
    };
  }

  private handleSubscriptionError(token: number, error: Error): void {
    if (!this.isCurrentToken(token)) return;
    this.dropActiveSubscription({ close: true });
    this.spec.onError?.(error);
    if (this.isTerminalError(error)) {
      this.markTerminal(error);
      return;
    }
    this.scheduleRetry(error);
  }

  private handleSubscriptionClose(token: number, error?: Error): void {
    if (!this.isCurrentToken(token)) return;
    this.dropActiveSubscription({ close: false });
    this.spec.onClose?.(error);
    if (error && this.isTerminalError(error)) {
      this.markTerminal(error);
      return;
    }
    this.scheduleRetry(error ?? new Error("Managed stream closed"));
  }

  private scheduleRetry(error: Error): void {
    if (this.closed || this.terminal) return;
    if (!this.isTransportReady()) {
      this.setSnapshot({
        state: "waiting",
        connected: false,
        error,
      });
      return;
    }

    const retryAttempt = this.snapshot.retryAttempt + 1;
    const delayMs = this.getRetryDelayMs(retryAttempt);
    this.setSnapshot({
      state: "retrying",
      connected: false,
      retryAttempt,
      error,
    });
    this.clearRetryTimer();
    this.retryTimer = this.scheduler.setTimeout(() => {
      this.retryTimer = null;
      this.trySubscribe();
    }, delayMs);
  }

  private markTerminal(error: Error): void {
    this.terminal = true;
    this.clearRetryTimer();
    this.setSnapshot({
      state: "terminal",
      connected: false,
      terminal: true,
      error,
    });
  }

  private dropActiveSubscription(options: { close: boolean }): void {
    const subscription = this.activeSubscription;
    this.activeSubscription = null;
    this.nextActiveToken();
    if (options.close) {
      subscription?.close();
    }
  }

  private nextActiveToken(): number {
    this.activeToken += 1;
    return this.activeToken;
  }

  private isCurrentToken(token: number): boolean {
    return !this.closed && !this.terminal && token === this.activeToken;
  }

  private isTransportReady(): boolean {
    return this.transport.status.getSnapshot().state === "ready";
  }

  private isTerminalError(error: Error): boolean {
    if (this.spec.isNonRetryableError) {
      return this.spec.isNonRetryableError(error);
    }
    if (isSourceTransportError(error)) return !error.retryable;
    return isConnectionNonRetryableError(error);
  }

  private getRetryDelayMs(retryAttempt: number): number {
    const exponentialDelay =
      this.retryInitialDelayMs *
      this.retryFactor ** Math.max(0, retryAttempt - 1);
    return Math.min(this.retryMaxDelayMs, exponentialDelay);
  }

  private clearRetryTimer(): void {
    if (this.retryTimer === null) return;
    this.scheduler.clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private setSnapshot(
    updates: Partial<ManagedStreamSnapshot> &
      Pick<ManagedStreamSnapshot, "state">,
  ): void {
    this.snapshot = {
      ...this.snapshot,
      ...updates,
    };
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}

function toError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(typeof error === "string" ? error : "Unknown stream error");
}
