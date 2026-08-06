import { describe, expect, it } from "vitest";
import {
  composeSeenNeedle,
  composeTimeAnchor,
  composeTimeAnchors,
  MAX_SEEN_NEEDLE_CHARS,
  MIN_COMPOSE_ANCHOR_SECONDS,
} from "../../src/supervisor/composeTimeAnchor.js";

const T0 = Date.UTC(2026, 5, 5, 0, 0, 0);

describe("composeTimeAnchor", () => {
  it("anchors the first chunk against delivery time", () => {
    expect(composeTimeAnchor(T0, T0 + 45_000, null)).toBe("(45s ago)");
  });

  it("rounds fractional seconds for the first chunk", () => {
    expect(composeTimeAnchor(T0, T0 + 12_400, null)).toBe("(12s ago)");
    expect(composeTimeAnchor(T0, T0 + 12_600, null)).toBe("(13s ago)");
  });

  it("omits the anchor below the threshold", () => {
    expect(
      composeTimeAnchor(T0, T0 + (MIN_COMPOSE_ANCHOR_SECONDS - 1) * 1000, null),
    ).toBeNull();
    // Exactly at the threshold is kept.
    expect(
      composeTimeAnchor(T0, T0 + MIN_COMPOSE_ANCHOR_SECONDS * 1000, null),
    ).toBe(`(${MIN_COMPOSE_ANCHOR_SECONDS}s ago)`);
  });

  it("computes the gap from the previous chunk for later chunks", () => {
    // Delivery time is irrelevant for a later chunk: only the inter-chunk gap.
    expect(composeTimeAnchor(T0 + 30_000, T0 + 999_000, T0)).toBe(
      "(30s later)",
    );
  });

  it("omits a later-chunk anchor when the gap is below threshold", () => {
    expect(composeTimeAnchor(T0 + 5_000, T0 + 999_000, T0)).toBeNull();
  });

  it("returns null for unusable timestamps", () => {
    expect(composeTimeAnchor(Number.NaN, T0 + 45_000, null)).toBeNull();
    expect(composeTimeAnchor(T0 + 30_000, T0 + 999_000, Number.NaN)).toBeNull();
  });

  it("computes age at delivery time, not at compose time", () => {
    // Same composed-at, two different delivery times -> different ages.
    expect(composeTimeAnchor(T0, T0 + 10_000, null)).toBe("(10s ago)");
    expect(composeTimeAnchor(T0, T0 + 600_000, null)).toBe("(600s ago)");
  });

  it("quotes the last-seen needle on the first chunk", () => {
    expect(composeTimeAnchor(T0, T0 + 45_000, null, "tail of output")).toBe(
      '(45s ago, had seen: "tail of output")',
    );
  });

  it("still omits a below-threshold anchor when a needle is present", () => {
    expect(composeTimeAnchor(T0, T0 + 3_000, null, "tail")).toBeNull();
  });
});

describe("composeSeenNeedle", () => {
  it("collapses whitespace and swaps double quotes for single", () => {
    expect(composeSeenNeedle('line one\n  "quoted"\ttail')).toBe(
      "line one 'quoted' tail",
    );
  });

  it("keeps short text verbatim", () => {
    expect(composeSeenNeedle("short tail")).toBe("short tail");
  });

  it("tail-truncates long text with a leading ellipsis", () => {
    const raw = "x".repeat(10) + "y".repeat(MAX_SEEN_NEEDLE_CHARS);
    const needle = composeSeenNeedle(raw);
    expect(needle).toBe(`…${"y".repeat(MAX_SEEN_NEEDLE_CHARS)}`);
  });

  it("returns null for blank input", () => {
    expect(composeSeenNeedle("  \n\t ")).toBeNull();
  });
});

describe("composeTimeAnchors", () => {
  it("anchors the first against delivery and each later against its predecessor", () => {
    const composedAt = [T0, T0 + 15_000, T0 + 18_000];
    expect(composeTimeAnchors(composedAt, T0 + 45_000)).toEqual([
      "(45s ago)", // 45s before delivery
      "(15s later)", // 15s after the first chunk
      null, // only 3s after the second chunk -> below threshold
    ]);
  });

  it("returns a single ago-anchor for one queued chunk", () => {
    expect(composeTimeAnchors([T0], T0 + 30_000)).toEqual(["(30s ago)"]);
  });

  it("omits all anchors when nothing crosses the threshold", () => {
    expect(composeTimeAnchors([T0, T0 + 2_000], T0 + 4_000)).toEqual([
      null,
      null,
    ]);
  });

  it("quotes the needle on the first chunk only", () => {
    expect(
      composeTimeAnchors([T0, T0 + 15_000], T0 + 45_000, [
        "first tail",
        "second tail",
      ]),
    ).toEqual(['(45s ago, had seen: "first tail")', "(15s later)"]);
  });
});
