// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import type { GlobalSessionItem } from "../../api/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider } from "../../contexts/ToastContext";
import {
  createClientSummaryHostSourceKey,
  reportGlobalSessionsCollectionSnapshot,
  reportSessionCollectionMetadataChanged,
  resetClientSummaryStoreForTests,
  setCurrentClientSummarySourceKey,
} from "../../lib/clientSummaryStore";
import { saveSessionDraft } from "../../lib/sessionDraftStorage";
import { Sidebar } from "../Sidebar";

vi.mock("../../lib/activityBus", () => ({
  activityBus: {
    on: vi.fn(() => () => {}),
    onSource: vi.fn(() => () => {}),
    retainSourceStream: vi.fn(() => () => {}),
  },
}));

vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => null,
}));

vi.mock("../../hooks/useDrafts", () => ({
  useNewSessionDraft: () => false,
}));

vi.mock("../../hooks/useProjectQueues", () => ({
  useProjectQueues: () => ({
    queuesByProject: {},
    items: [],
    projectStatusesByProject: {},
    recoveredSessionQueues: [],
    loading: false,
    error: null,
    mutatingItemId: null,
    mutatingDispatchState: false,
    mutatingPromoteItemId: null,
    dispatchState: { status: "running" },
    refetch: vi.fn(),
    pauseDispatch: vi.fn(),
    resumeDispatch: vi.fn(),
    promoteNow: vi.fn(),
    updateItem: vi.fn(),
    deleteItem: vi.fn(),
    retryItem: vi.fn(),
    moveItemToTop: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: [],
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/usePublicShareStatus", () => ({
  usePublicShareStatus: () => ({
    status: null,
  }),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "/remote/test",
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: {
      publicSharesEnabled: false,
    },
  }),
}));

vi.mock("../../hooks/useSidebarSessionFeeds", () => ({
  SIDEBAR_SESSION_FEED_LIMIT: 50,
  useSidebarSessionFeeds: () => ({
    globalQuery: { scope: "global-sessions" },
    starredQuery: { scope: "global-sessions", starred: true },
    loading: false,
    hasMoreGlobalSessions: false,
    loadMoreGlobalSessions: vi.fn(),
    hasMoreStarredSessions: false,
    loadMoreStarredSessions: vi.fn(),
  }),
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({
    version: {
      capabilities: [],
    },
  }),
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) =>
      (
        ({
          actionCloseSidebar: "Close sidebar",
          sidebarNewSession: "New Session",
          sidebarInbox: "Inbox",
          sidebarAllSessions: "All Sessions",
          sidebarProjects: "Projects",
          sidebarSettings: "Settings",
          sidebarSectionStarred: "Starred",
          sidebarSectionLast24Hours: "Last 24 Hours",
          sidebarSectionOlder: "Older",
          sidebarSectionExpand: "Expand",
          sidebarSectionCollapse: "Collapse",
          sidebarEmpty: "No sessions yet",
        }) as Record<string, string>
      )[key] ?? key,
  }),
}));

vi.mock("../AgentsNavItem", () => ({
  AgentsNavItem: () => null,
}));

vi.mock("../SessionListItem", () => ({
  SessionListItem: ({
    sessionId,
    title,
    hasDraft,
  }: {
    sessionId: string;
    title: string;
    hasDraft?: boolean;
  }) => (
    <li
      data-has-draft={String(hasDraft === true)}
      data-testid={`session-row-${sessionId}`}
    >
      <span>{title}</span>
      {hasDraft ? <span>Draft</span> : null}
    </li>
  ),
}));

const RECENT_MS = Date.now() - 60_000;
const RECENT = new Date(RECENT_MS).toISOString();

function session(
  id: string,
  title: string,
  overrides: Partial<GlobalSessionItem> = {},
): GlobalSessionItem {
  return {
    id,
    title,
    fullTitle: title,
    createdAt: RECENT,
    updatedAt: RECENT,
    messageCount: 1,
    provider: "claude",
    projectId: "project-1",
    projectName: "Project",
    ownership: { owner: "none" },
    isArchived: false,
    isStarred: false,
    ...overrides,
  };
}

function renderSidebar() {
  return render(
    <MemoryRouter>
      <ToastProvider>
        <Sidebar
          isOpen={true}
          onClose={() => {}}
          onNavigate={() => {}}
          isDesktop={true}
          isCollapsed={false}
        />
      </ToastProvider>
    </MemoryRouter>,
  );
}

function sectionRowIds(container: HTMLElement, listId: string): string[] {
  const list = container.querySelector(`#${listId}`);
  if (!list) {
    return [];
  }
  return Array.from(list.querySelectorAll("[data-testid^='session-row-']")).map(
    (element) =>
      element.getAttribute("data-testid")?.replace("session-row-", "") ?? "",
  );
}

describe("Sidebar client summary source registry", () => {
  beforeEach(() => {
    resetClientSummaryStoreForTests();
    localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
    resetClientSummaryStoreForTests();
  });

  it("rerenders rows and draft badges from only the current source", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");

    act(() => {
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions" },
          sessions: [session("mac-session", "MacBook session")],
          hasMore: false,
        },
        100,
      );
      reportGlobalSessionsCollectionSnapshot(
        winnative,
        {
          query: { scope: "global-sessions" },
          sessions: [session("win-session", "WinNative session")],
          hasMore: false,
        },
        100,
      );
      saveSessionDraft(
        { sourceKey: macbook, sessionId: "mac-session" },
        "mac draft",
      );
      saveSessionDraft(
        { sourceKey: winnative, sessionId: "win-session" },
        "win draft",
      );
      setCurrentClientSummarySourceKey(macbook);
    });

    renderSidebar();

    await waitFor(() => {
      expect(screen.getByTestId("session-row-mac-session")).toBeDefined();
    });
    expect(screen.queryByTestId("session-row-win-session")).toBeNull();
    expect(
      screen
        .getByTestId("session-row-mac-session")
        .getAttribute("data-has-draft"),
    ).toBe("true");

    act(() => {
      setCurrentClientSummarySourceKey(winnative);
    });

    await waitFor(() => {
      expect(screen.getByTestId("session-row-win-session")).toBeDefined();
    });
    expect(screen.queryByTestId("session-row-mac-session")).toBeNull();
    expect(
      screen
        .getByTestId("session-row-win-session")
        .getAttribute("data-has-draft"),
    ).toBe("true");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
    });

    await waitFor(() => {
      expect(screen.getByTestId("session-row-mac-session")).toBeDefined();
    });
    expect(screen.queryByTestId("session-row-win-session")).toBeNull();
    expect(
      screen
        .getByTestId("session-row-mac-session")
        .getAttribute("data-has-draft"),
    ).toBe("true");
  });

  it("renders locally starred known rows before starred query refetches", async () => {
    const macbook = createClientSummaryHostSourceKey("macbook");

    act(() => {
      setCurrentClientSummarySourceKey(macbook);
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions" },
          sessions: [session("star-later", "Star later")],
          hasMore: false,
        },
        100,
      );
      reportGlobalSessionsCollectionSnapshot(
        macbook,
        {
          query: { scope: "global-sessions", starred: true },
          sessions: [],
          hasMore: false,
        },
        100,
      );
    });

    const { container } = renderSidebar();

    await waitFor(() => {
      expect(sectionRowIds(container, "sidebar-last-24-hours-list")).toEqual([
        "star-later",
      ]);
    });
    expect(sectionRowIds(container, "sidebar-starred-list")).toEqual([]);

    act(() => {
      reportSessionCollectionMetadataChanged(
        macbook,
        {
          type: "session-metadata-changed",
          sessionId: "star-later",
          starred: true,
          timestamp: new Date(RECENT_MS + 60_000).toISOString(),
        },
        200,
      );
    });

    await waitFor(() => {
      expect(sectionRowIds(container, "sidebar-starred-list")).toEqual([
        "star-later",
      ]);
    });
    expect(sectionRowIds(container, "sidebar-last-24-hours-list")).toEqual([]);
  });
});
