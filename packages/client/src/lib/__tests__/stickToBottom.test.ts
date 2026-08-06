import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  STICK_TO_BOTTOM_NEAR_PX,
  isNearScrollBottom,
  useStickToBottom,
} from "../stickToBottom";

type ScrollMetrics = {
  scrollHeight: number;
  clientHeight: number;
  scrollTop: number;
};

/** A minimal stand-in for the scroll element: the hook only touches these
 * three numeric properties, so a plain mutable object exercises it faithfully
 * without a real layout engine. Kept as mutable metrics (HTMLElement types
 * scrollHeight/clientHeight read-only); cast to a ref at the boundary. */
function makeEl(metrics: ScrollMetrics): ScrollMetrics {
  return { ...metrics };
}

function refTo(el: ScrollMetrics): { current: HTMLElement | null } {
  return { current: el as unknown as HTMLElement };
}

describe("isNearScrollBottom", () => {
  it("is true exactly at the bottom", () => {
    expect(
      isNearScrollBottom({
        scrollHeight: 1000,
        clientHeight: 200,
        scrollTop: 800,
      }),
    ).toBe(true);
  });

  it("is true within the near threshold", () => {
    expect(
      isNearScrollBottom({
        scrollHeight: 1000,
        clientHeight: 200,
        scrollTop: 800 - STICK_TO_BOTTOM_NEAR_PX,
      }),
    ).toBe(true);
  });

  it("is false once scrolled up beyond the threshold", () => {
    expect(
      isNearScrollBottom({
        scrollHeight: 1000,
        clientHeight: 200,
        scrollTop: 800 - STICK_TO_BOTTOM_NEAR_PX - 1,
      }),
    ).toBe(false);
  });
});

describe("useStickToBottom", () => {
  it("pins to the bottom on mount and as the dependency grows", () => {
    const el = makeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    const ref = refTo(el);
    const { rerender } = renderHook(
      ({ dep }) => useStickToBottom(ref, dep, { enabled: true }),
      { initialProps: { dep: "a" } },
    );

    expect(el.scrollTop).toBe(1000);

    el.scrollHeight = 1500;
    rerender({ dep: "ab" });
    expect(el.scrollTop).toBe(1500);
  });

  it("cancels follow on scroll-up and re-engages when scrolled back near bottom", () => {
    const el = makeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    const ref = refTo(el);
    const { result, rerender } = renderHook(
      ({ dep }) => useStickToBottom(ref, dep, { enabled: true }),
      { initialProps: { dep: "a" } },
    );

    // User scrolls up to read; follow should cancel.
    el.scrollTop = 100;
    act(() => result.current.onScroll());
    el.scrollHeight = 1500;
    rerender({ dep: "ab" });
    expect(el.scrollTop).toBe(100);

    // User scrolls back within the near band; follow re-engages.
    el.scrollTop = 1500 - 200; // exactly at bottom
    act(() => result.current.onScroll());
    el.scrollHeight = 1800;
    rerender({ dep: "abc" });
    expect(el.scrollTop).toBe(1800);
  });

  it("never scrolls when disabled (static/previous thinking)", () => {
    const el = makeEl({ scrollHeight: 1000, clientHeight: 200, scrollTop: 0 });
    const ref = refTo(el);
    const { rerender } = renderHook(
      ({ dep }) => useStickToBottom(ref, dep, { enabled: false }),
      { initialProps: { dep: "a" } },
    );

    expect(el.scrollTop).toBe(0);
    el.scrollHeight = 2000;
    rerender({ dep: "b" });
    expect(el.scrollTop).toBe(0);
  });

  it("starts following when a new logical stream replaces scrolled-up content", () => {
    const el = makeEl({
      scrollHeight: 1000,
      clientHeight: 200,
      scrollTop: 100,
    });
    const ref = refTo(el);
    const { result, rerender } = renderHook(
      ({ dep, enabled, identity }) =>
        useStickToBottom(ref, dep, { enabled, identity }),
      {
        initialProps: {
          dep: "finished",
          enabled: false,
          identity: "old-thinking",
        },
      },
    );
    act(() => result.current.onScroll());

    el.scrollHeight = 1500;
    rerender({
      dep: "new stream",
      enabled: true,
      identity: "new-thinking",
    });

    expect(el.scrollTop).toBe(1500);
  });
});
