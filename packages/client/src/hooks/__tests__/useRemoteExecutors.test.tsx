// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { serverSettingsState, updateSetting, refetch } = vi.hoisted(() => ({
  serverSettingsState: {
    settings: { remoteExecutors: ["alpha"] } as {
      remoteExecutors?: string[];
    } | null,
    isLoading: false,
    error: null as string | null,
  },
  updateSetting: vi.fn(async () => {}),
  refetch: vi.fn(async () => {}),
}));

vi.mock("../useServerSettings", () => ({
  useServerSettings: () => ({
    ...serverSettingsState,
    updateSetting,
    refetch,
  }),
}));

vi.mock("../../api/client", () => ({
  api: {
    testRemoteExecutor: vi.fn(),
  },
}));

import { useRemoteExecutors } from "../useRemoteExecutors";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  serverSettingsState.settings = { remoteExecutors: ["alpha"] };
  serverSettingsState.isLoading = false;
  serverSettingsState.error = null;
});

describe("useRemoteExecutors", () => {
  it("updates the shared server-settings snapshot owner", async () => {
    const { result } = renderHook(() => useRemoteExecutors());

    expect(result.current.executors).toEqual(["alpha"]);
    await act(() => result.current.addExecutor(" beta "));
    expect(updateSetting).toHaveBeenCalledWith("remoteExecutors", [
      "alpha",
      "beta",
    ]);

    await act(() => result.current.removeExecutor("alpha"));
    expect(updateSetting).toHaveBeenCalledWith("remoteExecutors", []);

    await act(() => result.current.replaceExecutors(["gamma"]));
    expect(updateSetting).toHaveBeenCalledWith("remoteExecutors", ["gamma"]);
  });

  it("reports loading until the shared settings query resolves", () => {
    serverSettingsState.settings = null;
    serverSettingsState.isLoading = true;

    const { result } = renderHook(() => useRemoteExecutors());

    expect(result.current.loading).toBe(true);
    expect(result.current.executors).toEqual([]);
  });
});
