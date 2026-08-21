// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDocumentAttention } from "../useDocumentAttention";

let visibilityState: DocumentVisibilityState;
let focused: boolean;

beforeEach(() => {
  visibilityState = "visible";
  focused = true;
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibilityState,
  );
  vi.spyOn(document, "hasFocus").mockImplementation(() => focused);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useDocumentAttention", () => {
  it("tracks both page visibility and window focus", () => {
    const rendered = renderHook(() => useDocumentAttention());
    expect(rendered.result.current).toBe(true);

    act(() => {
      focused = false;
      window.dispatchEvent(new Event("blur"));
    });
    expect(rendered.result.current).toBe(false);

    act(() => {
      focused = true;
      window.dispatchEvent(new Event("focus"));
    });
    expect(rendered.result.current).toBe(true);

    act(() => {
      visibilityState = "hidden";
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(rendered.result.current).toBe(false);
  });
});
