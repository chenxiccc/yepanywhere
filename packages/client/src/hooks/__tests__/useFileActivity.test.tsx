// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityBus, type FileChangeEvent } from "../../lib/activityBus";
import { useFileActivity } from "../useFileActivity";

function makeFileChange(relativePath: string): FileChangeEvent {
  return {
    type: "file-change",
    provider: "claude",
    path: `/home/user/${relativePath}`,
    relativePath,
    changeType: "modify",
    timestamp: new Date().toISOString(),
    fileType: "other",
  };
}

afterEach(() => {
  cleanup();
});

describe("useFileActivity event buffering", () => {
  it("does not retain activity callbacks while disabled", () => {
    const onFileChange = vi.fn();
    renderHook(() => useFileActivity({ enabled: false, onFileChange }));

    act(() => {
      activityBus.emitLocal("file-change", makeFileChange("hidden.txt"));
    });

    expect(onFileChange).not.toHaveBeenCalled();
  });

  it("does not buffer events for callback-only consumers", () => {
    const onFileChange = vi.fn();
    const { result } = renderHook(() => useFileActivity({ onFileChange }));
    const initialEvents = result.current.events;

    act(() => {
      activityBus.emitLocal("file-change", makeFileChange("a.txt"));
      activityBus.emitLocal("file-change", makeFileChange("b.txt"));
    });

    expect(onFileChange).toHaveBeenCalledTimes(2);
    // Same array identity: no buffering setState ran for these events.
    expect(result.current.events).toBe(initialEvents);
    expect(result.current.events).toEqual([]);
  });

  it("buffers events newest-first for opted-in consumers", () => {
    const { result } = renderHook(() =>
      useFileActivity({ bufferEvents: true }),
    );

    act(() => {
      activityBus.emitLocal("file-change", makeFileChange("a.txt"));
      activityBus.emitLocal("file-change", makeFileChange("b.txt"));
    });

    expect(result.current.events.map((e) => e.relativePath)).toEqual([
      "b.txt",
      "a.txt",
    ]);
  });
});
