// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GlobalSessionItem } from "../../api/client";
import "../../../test/pointerEventShim";
import { RecentSessionsDropdown } from "../RecentSessionsDropdown";

const { globalSessionsState } = vi.hoisted(() => ({
  globalSessionsState: {
    sessions: [] as GlobalSessionItem[],
  },
}));

vi.mock("../../hooks/useGlobalSessionsFeed", () => ({
  useGlobalSessionsFeed: () => ({
    query: { scope: "global-sessions" },
  }),
}));

vi.mock("../../lib/clientSummaryStore", () => ({
  useSessionCollectionQueryRecords: () => globalSessionsState.sessions,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

function session(
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id: "session-2",
    title: "Shortened title...",
    fullTitle:
      "Longer complete title text that should be visible in the recent sessions dropdown",
    createdAt: "2026-06-24T10:00:00.000Z",
    updatedAt: "2026-06-24T10:05:00.000Z",
    messageCount: 3,
    provider: "codex",
    projectId: "project-1",
    projectName: "yepanywhere",
    ownership: { owner: "none" },
    ...overrides,
  };
}

function triggerRef() {
  const element = document.createElement("button");
  element.getBoundingClientRect = () =>
    ({
      bottom: 48,
      height: 24,
      left: 120,
      right: 240,
      top: 24,
      width: 120,
      x: 120,
      y: 24,
      toJSON: () => ({}),
    }) as DOMRect;

  const ref = createRef<HTMLElement>();
  Object.defineProperty(ref, "current", {
    value: element,
  });
  return ref;
}

describe("RecentSessionsDropdown", () => {
  afterEach(() => {
    cleanup();
    globalSessionsState.sessions = [];
    document.body.replaceChildren();
  });

  it("renders the full title instead of the shortened list title", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    expect(
      screen.getByText(
        "Longer complete title text that should be visible in the recent sessions dropdown",
      ),
    ).not.toBeNull();
    expect(screen.queryByText("Shortened title...")).toBeNull();
  });

  it("keeps session-switch tooltips off touch activation", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const item = screen.getByRole("link");
    expect(item.getAttribute("title")).toBeNull();

    fireEvent.pointerEnter(item, { pointerType: "touch" });
    expect(item.getAttribute("title")).toBeNull();
    expect(item.getAttribute("data-tooltip")).toBeNull();

    fireEvent.pointerEnter(item, { pointerType: "mouse" });
    expect(item.getAttribute("title")).toBe(
      "Longer complete title text that should be visible in the recent sessions dropdown",
    );

    fireEvent.pointerDown(item, { pointerType: "touch" });
    expect(item.getAttribute("title")).toBeNull();
  });

  it("exposes the complete session title to keyboard focus", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const item = screen.getByRole("link");
    fireEvent.focus(item);

    expect(item.getAttribute("title")).toBe(
      "Longer complete title text that should be visible in the recent sessions dropdown",
    );
  });

  it("keeps the global /btw hooks the shared index.css rules match on", () => {
    globalSessionsState.sessions = [
      session({
        title: "/btw check the flaky test",
        fullTitle: "/btw check the flaky test",
        parentSessionId: "session-parent",
      }),
    ];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole("link", { name: /check the flaky test/ });
    expect(row.classList.contains("recent-session-item")).toBe(true);
    expect(row.classList.contains("btw-aside-session")).toBe(true);

    const titleRow = row.firstElementChild?.firstElementChild as HTMLElement;
    expect(titleRow.classList.contains("recent-session-title")).toBe(true);

    const badge = screen.getByText("/btw");
    expect(badge.classList.contains("recent-sessions-badge")).toBe(true);
    expect(badge.classList.contains("btw")).toBe(true);
  });

  it("does not put the /btw interop hooks on ordinary rows", () => {
    globalSessionsState.sessions = [session()];

    render(
      <MemoryRouter>
        <RecentSessionsDropdown
          currentSessionId="session-1"
          isOpen={true}
          onClose={vi.fn()}
          onNavigate={vi.fn()}
          triggerRef={triggerRef()}
        />
      </MemoryRouter>,
    );

    const row = screen.getByRole("link");
    expect(row.classList.contains("recent-session-item")).toBe(false);
    expect(row.classList.contains("btw-aside-session")).toBe(false);
  });
});
