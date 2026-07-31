import { describe, expect, it } from "vitest";
import { FixedWindowRateLimiter } from "../src/rate-limiter.js";

describe("FixedWindowRateLimiter", () => {
  it("allows the configured count and reports the retry window", () => {
    let now = 1_000;
    const limiter = new FixedWindowRateLimiter({
      limit: 2,
      windowMs: 10_000,
      now: () => now,
    });

    expect(limiter.consume("a")).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a")).toEqual({
      allowed: false,
      retryAfterSeconds: 9,
    });

    now = 10_000;
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("keeps independent subjects", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      now: () => 0,
    });

    expect(limiter.consume("a").allowed).toBe(true);
    expect(limiter.consume("a").allowed).toBe(false);
    expect(limiter.consume("b").allowed).toBe(true);
  });

  it("bounds retained subjects without a cleanup timer", () => {
    const limiter = new FixedWindowRateLimiter({
      limit: 1,
      windowMs: 1_000,
      maxEntries: 2,
      now: () => 0,
    });

    limiter.consume("a");
    limiter.consume("b");
    limiter.consume("c");

    expect(limiter.size).toBe(2);
    expect(limiter.consume("a").allowed).toBe(true);
  });

  it("rejects invalid limits", () => {
    expect(
      () => new FixedWindowRateLimiter({ limit: 0, windowMs: 1_000 }),
    ).toThrow();
    expect(
      () => new FixedWindowRateLimiter({ limit: 1, windowMs: 0 }),
    ).toThrow();
    expect(
      () =>
        new FixedWindowRateLimiter({
          limit: 1,
          windowMs: 1_000,
          maxEntries: 0,
        }),
    ).toThrow();
  });
});
