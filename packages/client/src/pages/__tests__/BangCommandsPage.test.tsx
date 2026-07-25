// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BangCommandsPage } from "../BangCommandsPage";

const { mockNavigate, mockFetchBangCommandHistory } = vi.hoisted(() => ({
  mockNavigate: vi.fn(),
  mockFetchBangCommandHistory: vi.fn(),
}));

vi.mock("react-router-dom", async () => {
  const actual =
    await vi.importActual<typeof import("react-router-dom")>(
      "react-router-dom",
    );
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("../../api/client", () => ({
  api: {
    fetchBangCommandHistory: mockFetchBangCommandHistory,
    fetchBangCommandOutput: vi.fn(),
  },
}));

// The block component fetches rendered output on demand; stub it so the test
// exercises the page's per-entry actions, not the display object internals.
vi.mock("../../components/BangCommandDisplayObject", () => ({
  BangCommandDisplayObject: ({
    object,
  }: {
    object: { id: string; command: string };
  }) => <div data-testid={`bang-block-${object.id}`}>{object.command}</div>,
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => {
      const messages: Record<string, string> = {
        bangHistoryTitle: "!! Commands",
        bangHistoryEmpty: "No bang commands yet",
        bangHistoryOpenSession: "Open session",
        bangHistoryActionEdit: "Edit / re-issue command",
        bangHistoryActionNew: "New command in session",
        bangHistoryActionJump: "Jump to command in session",
      };
      return messages[key] ?? key;
    },
  }),
}));

vi.mock("../../layouts", () => ({
  MainContent: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
  }),
}));

function makeObject(id: string, command: string) {
  return {
    id,
    kind: "bang-command" as const,
    createdAt: "2026-07-24T00:00:00.000Z",
    placementAfterMessageId: "",
    command,
    cwd: "/tmp/alpha",
    status: "done" as const,
    exitCode: 0,
  };
}

const PROJECTFUL_ENTRY = {
  sessionId: "session-1",
  projectId: "project-1",
  object: makeObject("obj-1", "git status"),
};

const SESSIONLESS_ENTRY = {
  sessionId: "session-2",
  // No projectId: the actions (and open-session link) must not render.
  object: makeObject("obj-2", "ls"),
};

function renderPage() {
  render(
    <MemoryRouter initialEntries={["/bang-commands"]}>
      <Routes>
        <Route path="/bang-commands" element={<BangCommandsPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("BangCommandsPage per-entry actions", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the three actions only for entries with a project", async () => {
    mockFetchBangCommandHistory.mockResolvedValue({
      entries: [PROJECTFUL_ENTRY, SESSIONLESS_ENTRY],
    });

    renderPage();

    // Both blocks render; only the projectful entry gets the action icons.
    expect(await screen.findByTestId("bang-block-obj-1")).toBeDefined();
    expect(screen.getByTestId("bang-block-obj-2")).toBeDefined();

    expect(
      screen.getAllByLabelText("Edit / re-issue command"),
    ).toHaveLength(1);
    expect(screen.getAllByLabelText("New command in session")).toHaveLength(1);
    expect(
      screen.getAllByLabelText("Jump to command in session"),
    ).toHaveLength(1);
  });

  it("edit navigates to the source session prefilling !!<command>", async () => {
    mockFetchBangCommandHistory.mockResolvedValue({
      entries: [PROJECTFUL_ENTRY],
    });

    renderPage();

    fireEvent.click(await screen.findByLabelText("Edit / re-issue command"));

    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/project-1/sessions/session-1",
      { state: { composerPrefill: "!!git status" } },
    );
  });

  it("new navigates to the source session focusing the composer", async () => {
    mockFetchBangCommandHistory.mockResolvedValue({
      entries: [PROJECTFUL_ENTRY],
    });

    renderPage();

    fireEvent.click(await screen.findByLabelText("New command in session"));

    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/project-1/sessions/session-1",
      { state: { focusComposer: true } },
    );
  });

  it("jump navigates to the source session scrolled to the bang render row", async () => {
    mockFetchBangCommandHistory.mockResolvedValue({
      entries: [PROJECTFUL_ENTRY],
    });

    renderPage();

    fireEvent.click(await screen.findByLabelText("Jump to command in session"));

    // The bang block's data-render-id is the transcript display object id.
    expect(mockNavigate).toHaveBeenCalledWith(
      "/projects/project-1/sessions/session-1",
      { state: { scrollToRenderId: "obj-1" } },
    );
  });
});
