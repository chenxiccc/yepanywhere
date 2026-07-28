// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useHostAgentProcesses } from "../useHostAgentProcesses";

const mocks = vi.hoisted(() => {
  const fetch = vi.fn();
  return {
    fetch,
    transport: { fetch },
    remoteConnection: null as { connection: object | null } | null,
    remoteClient: false,
    settings: {
      hostProcessObservabilityEnabled: true as boolean | undefined,
    },
    version: {
      capabilities: ["host-agent-process-observability"],
    },
  };
});

vi.mock("../useVersion", () => ({
  useVersion: () => ({ version: mocks.version }),
}));

vi.mock("../useServerSettings", () => ({
  useServerSettings: () => ({ settings: mocks.settings }),
}));

vi.mock("../../contexts/SourceRuntimeContext", () => ({
  useCurrentSourceRuntime: () => ({
    transport: mocks.transport,
  }),
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => mocks.remoteConnection,
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: () => mocks.remoteClient,
}));

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("useHostAgentProcesses", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue({
      enabled: true,
      supported: true,
      sampledAt: "2026-07-28T12:00:00.000Z",
      observations: [],
    });
    mocks.version.capabilities = ["host-agent-process-observability"];
    mocks.settings.hostProcessObservabilityEnabled = true;
    mocks.remoteClient = false;
    mocks.remoteConnection = null;
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: false,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("polls while mounted and visible, then stops when hidden", async () => {
    const hook = renderHook(() => useHostAgentProcesses());
    await settle();

    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledWith("/host-agent-processes");
    expect(hook.result.current.supported).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(mocks.fetch).toHaveBeenCalledTimes(2);

    hook.unmount();
  });

  it("makes no request without the capability", async () => {
    mocks.version.capabilities = [];

    renderHook(() => useHostAgentProcesses());
    await settle();

    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("makes no request after the server setting is disabled", async () => {
    mocks.settings.hostProcessObservabilityEnabled = false;

    renderHook(() => useHostAgentProcesses());
    await settle();

    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
