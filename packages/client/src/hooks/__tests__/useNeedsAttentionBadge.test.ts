// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getTabTitleActivityFrame,
  composeTabTitle,
  stripTabTitlePrefixes,
  TAB_TITLE_ACTIVITY_CADENCE_MS,
  useNeedsAttentionBadge,
} from "../useNeedsAttentionBadge";

const { inboxCounts, preferenceState } = vi.hoisted(() => ({
  inboxCounts: {
    needsAttention: 0,
    active: 0,
    total: 0,
  },
  preferenceState: {
    tabTitleActivityEnabled: false,
  },
}));

vi.mock("../../lib/clientSummaryStore", () => ({
  useInboxCounts: () => inboxCounts,
}));

vi.mock("../useTabTitleActivityPreference", () => ({
  useTabTitleActivityPreference: () => preferenceState,
}));

describe("tab title indicators", () => {
  beforeEach(() => {
    document.title = "Project - Session";
    inboxCounts.needsAttention = 0;
    inboxCounts.active = 0;
    inboxCounts.total = 0;
    preferenceState.tabTitleActivityEnabled = false;
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("composes attention and activity prefixes in stable order", () => {
    expect(composeTabTitle("Project", 2, "(●)", "💻")).toBe(
      "(2) (●) 💻 Project",
    );
  });

  it("strips known prefixes before recomposing", () => {
    expect(stripTabTitlePrefixes("(2) (●) Project")).toBe("Project");
    expect(stripTabTitlePrefixes("(○) (3) Project")).toBe("Project");
    expect(stripTabTitlePrefixes("(2) (*) Project")).toBe("Project");
    expect(stripTabTitlePrefixes("( ) (3) Project")).toBe("Project");
    expect(stripTabTitlePrefixes("(2) (●) 💻 Project", "💻")).toBe("Project");
  });

  it("derives activity frames from the configured cadence", () => {
    expect(getTabTitleActivityFrame(1000, 1000)).toBe("(●)");
    expect(
      getTabTitleActivityFrame(1000, 1000 + TAB_TITLE_ACTIVITY_CADENCE_MS),
    ).toBe("(○)");
    expect(
      getTabTitleActivityFrame(1000, 1000 + TAB_TITLE_ACTIVITY_CADENCE_MS * 2),
    ).toBe("(●)");
  });

  it("shows all-session activity when enabled and sessions are active", () => {
    inboxCounts.active = 1;
    inboxCounts.total = 1;
    preferenceState.tabTitleActivityEnabled = true;

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("(●) Project - Session");
  });

  it("animates all-session activity on the configured cadence", () => {
    vi.useFakeTimers();
    inboxCounts.active = 1;
    inboxCounts.total = 1;
    preferenceState.tabTitleActivityEnabled = true;

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("(●) Project - Session");

    act(() => {
      vi.advanceTimersByTime(TAB_TITLE_ACTIVITY_CADENCE_MS);
    });

    expect(document.title).toBe("(○) Project - Session");
  });

  it("does not show activity while disabled", () => {
    inboxCounts.active = 1;
    inboxCounts.total = 1;
    preferenceState.tabTitleActivityEnabled = false;

    renderHook(() => useNeedsAttentionBadge());

    expect(document.title).toBe("Project - Session");
  });

  it("keeps the host marker after attention prefixes", () => {
    inboxCounts.needsAttention = 2;

    renderHook(() => useNeedsAttentionBadge("❤️"));

    expect(document.title).toBe("(2) ❤️ Project - Session");
  });

  it("replaces a changed host marker without duplicating prefixes", () => {
    const view = renderHook(
      ({ icon }: { icon: string }) => useNeedsAttentionBadge(icon),
      { initialProps: { icon: "❤️" } },
    );
    expect(document.title).toBe("❤️ Project - Session");

    view.rerender({ icon: "💻" });

    expect(document.title).toBe("💻 Project - Session");
  });
});
