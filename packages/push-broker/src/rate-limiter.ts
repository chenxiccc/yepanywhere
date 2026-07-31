export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface WindowEntry {
  window: number;
  count: number;
}

export interface FixedWindowRateLimiterOptions {
  limit: number;
  windowMs: number;
  maxEntries?: number;
  now?: () => number;
}

/**
 * A bounded, process-local fixed-window rate limiter.
 *
 * Map insertion order acts as a small LRU. There is no cleanup timer, so an
 * idle broker retains no scheduled work. Restarting the process resets limits.
 */
export class FixedWindowRateLimiter {
  private readonly entries = new Map<string, WindowEntry>();
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(options: FixedWindowRateLimiterOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1) {
      throw new Error("Rate limit must be a positive integer");
    }
    if (!Number.isInteger(options.windowMs) || options.windowMs < 1) {
      throw new Error("Rate-limit window must be a positive integer");
    }
    if (
      options.maxEntries !== undefined &&
      (!Number.isInteger(options.maxEntries) || options.maxEntries < 1)
    ) {
      throw new Error("Rate-limit capacity must be a positive integer");
    }

    this.limit = options.limit;
    this.windowMs = options.windowMs;
    this.maxEntries = options.maxEntries ?? 10_000;
    this.now = options.now ?? Date.now;
  }

  consume(key: string): RateLimitResult {
    const now = this.now();
    const window = Math.floor(now / this.windowMs);
    const existing = this.entries.get(key);

    if (!existing || existing.window !== window) {
      this.remember(key, { window, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }

    const retryAfterSeconds = Math.max(
      1,
      Math.ceil(((window + 1) * this.windowMs - now) / 1000),
    );
    if (existing.count >= this.limit) {
      this.remember(key, existing);
      return { allowed: false, retryAfterSeconds };
    }

    this.remember(key, { window, count: existing.count + 1 });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  get size(): number {
    return this.entries.size;
  }

  private remember(key: string, entry: WindowEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);

    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
    }
  }
}
