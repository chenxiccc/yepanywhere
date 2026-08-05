import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadMore: vi.fn(),
  useGlobalSessionsFeed: vi.fn(),
}));

vi.mock("../useGlobalSessionsFeed", () => ({
  useGlobalSessionsFeed: mocks.useGlobalSessionsFeed,
}));

import {
  SIDEBAR_SESSION_FEED_LIMIT,
  SidebarSessionFeedsProvider,
  useSidebarSessionFeeds,
} from "../useSidebarSessionFeeds";

function withProvider({ children }: { children: ReactNode }) {
  return <SidebarSessionFeedsProvider>{children}</SidebarSessionFeedsProvider>;
}

beforeEach(() => {
  mocks.loadMore.mockReset();
  mocks.useGlobalSessionsFeed.mockReset();
  mocks.useGlobalSessionsFeed.mockReturnValue({
    query: { scope: "global-sessions" },
    loading: false,
    hasMore: false,
    loadMore: mocks.loadMore,
  });
});

describe("SidebarSessionFeedsProvider", () => {
  it("retains global and starred sidebar coverage", () => {
    renderHook(() => useSidebarSessionFeeds(), { wrapper: withProvider });

    expect(mocks.useGlobalSessionsFeed).toHaveBeenCalledTimes(2);
    expect(mocks.useGlobalSessionsFeed).toHaveBeenNthCalledWith(1, {
      limit: SIDEBAR_SESSION_FEED_LIMIT,
      includeStats: false,
    });
    expect(mocks.useGlobalSessionsFeed).toHaveBeenNthCalledWith(2, {
      starred: true,
      limit: SIDEBAR_SESSION_FEED_LIMIT,
      includeStats: false,
    });
  });

  it("mounts one feed pair however many consumers read it", () => {
    renderHook(
      () => {
        useSidebarSessionFeeds();
        useSidebarSessionFeeds();
        useSidebarSessionFeeds();
      },
      { wrapper: withProvider },
    );

    expect(mocks.useGlobalSessionsFeed).toHaveBeenCalledTimes(2);
  });
});

describe("useSidebarSessionFeeds", () => {
  it("keeps the visible Sidebar load-more controls wired to the same coverage", () => {
    const globalLoadMore = vi.fn();
    const starredLoadMore = vi.fn();
    mocks.useGlobalSessionsFeed
      .mockReturnValueOnce({
        query: { scope: "global-sessions" },
        loading: false,
        hasMore: true,
        loadMore: globalLoadMore,
      })
      .mockReturnValueOnce({
        query: { scope: "global-sessions", starred: true },
        loading: true,
        hasMore: false,
        loadMore: starredLoadMore,
      });

    const { result } = renderHook(() => useSidebarSessionFeeds(), {
      wrapper: withProvider,
    });

    expect(mocks.useGlobalSessionsFeed).toHaveBeenCalledTimes(2);
    expect(result.current.globalQuery).toEqual({ scope: "global-sessions" });
    expect(result.current.starredQuery).toEqual({
      scope: "global-sessions",
      starred: true,
    });
    expect(result.current.loading).toBe(true);
    expect(result.current.hasMoreGlobalSessions).toBe(true);
    expect(result.current.loadMoreGlobalSessions).toBe(globalLoadMore);
    expect(result.current.hasMoreStarredSessions).toBe(false);
    expect(result.current.loadMoreStarredSessions).toBe(starredLoadMore);
  });

  it("refuses to mount its own feeds when the provider is missing", () => {
    // A fallback that mounted feeds here would silently restore the duplicate
    // pair the provider exists to remove, so the absence has to be loud.
    expect(() => renderHook(() => useSidebarSessionFeeds())).toThrow(
      /SidebarSessionFeedsProvider/,
    );
    expect(mocks.useGlobalSessionsFeed).not.toHaveBeenCalled();
  });
});
