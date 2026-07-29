// @vitest-environment jsdom

import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useProviderSubscriptionUsage } from "../useProviderSubscriptionUsage";

const { mockGetUsage, state } = vi.hoisted(() => ({
  mockGetUsage: vi.fn(),
  state: {
    capabilities: [] as string[],
    sourceKey: "usage-source-1",
  },
}));

vi.mock("../../api/client", () => ({
  api: {
    getProviderSubscriptionUsage: mockGetUsage,
  },
}));

vi.mock("../useVersion", () => ({
  useVersion: () => ({
    version: { capabilities: state.capabilities },
  }),
}));

vi.mock("../../lib/clientSummaryStore", () => ({
  useClientSummarySourceKey: () => state.sourceKey,
}));

describe("useProviderSubscriptionUsage", () => {
  beforeEach(() => {
    state.capabilities = [];
    state.sourceKey = `usage-source-${Math.random()}`;
    mockGetUsage.mockReset();
    mockGetUsage.mockResolvedValue({ usage: null });
  });

  it("makes no request until the server advertises the capability", async () => {
    const { result } = renderHook(() =>
      useProviderSubscriptionUsage("claude"),
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGetUsage).not.toHaveBeenCalled();
  });

  it("loads and explicitly refreshes source-keyed usage", async () => {
    state.capabilities = ["provider-subscription-usage"];
    mockGetUsage.mockResolvedValue({
      usage: {
        provider: "claude",
        fetchedAt: "2026-07-29T00:00:00.000Z",
        windows: [
          {
            id: "weekly",
            usedPercent: 72,
            scope: { type: "provider" },
          },
        ],
      },
    });

    const { result } = renderHook(() =>
      useProviderSubscriptionUsage("claude"),
    );
    await waitFor(() =>
      expect(result.current.usage?.windows[0]?.usedPercent).toBe(72),
    );
    expect(mockGetUsage).toHaveBeenCalledWith("claude", { refresh: false });

    await act(async () => {
      await result.current.refresh();
    });
    expect(mockGetUsage).toHaveBeenLastCalledWith("claude", {
      refresh: true,
    });
  });
});
