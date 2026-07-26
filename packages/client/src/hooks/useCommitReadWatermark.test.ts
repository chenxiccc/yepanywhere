// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useCommitReadWatermark } from "./useCommitReadWatermark";

const OLD = "2026-07-01T00:00:00Z";
const MID = "2026-07-15T00:00:00Z";
const NEW = "2026-07-26T00:00:00Z";

describe("useCommitReadWatermark", () => {
  afterEach(() => {
    localStorage.clear();
  });

  it("marks nothing read until a boundary is set", () => {
    const { result } = renderHook(() => useCommitReadWatermark("p1"));
    expect(result.current.isRead(OLD)).toBe(false);
    expect(result.current.isRead(NEW)).toBe(false);
  });

  it("mark read to here reads that commit and everything older", () => {
    const { result } = renderHook(() => useCommitReadWatermark("p1"));
    act(() => result.current.markReadTo(MID));
    expect(result.current.isRead(OLD)).toBe(true);
    expect(result.current.isRead(MID)).toBe(true);
    expect(result.current.isRead(NEW)).toBe(false);
  });

  it("mark unread since here leaves that commit and newer unread", () => {
    const { result } = renderHook(() => useCommitReadWatermark("p1"));
    act(() => result.current.markReadTo(NEW)); // all read
    act(() => result.current.markUnreadSince(MID)); // MID and newer unread again
    expect(result.current.isRead(OLD)).toBe(true);
    expect(result.current.isRead(MID)).toBe(false);
    expect(result.current.isRead(NEW)).toBe(false);
  });

  it("persists the boundary per project across remounts", () => {
    const first = renderHook(() => useCommitReadWatermark("p1"));
    act(() => first.result.current.markReadTo(MID));
    first.unmount();

    const second = renderHook(() => useCommitReadWatermark("p1"));
    expect(second.result.current.isRead(OLD)).toBe(true);
    expect(second.result.current.isRead(NEW)).toBe(false);

    // A different project keeps its own (empty) boundary.
    const other = renderHook(() => useCommitReadWatermark("p2"));
    expect(other.result.current.isRead(OLD)).toBe(false);
  });
});
