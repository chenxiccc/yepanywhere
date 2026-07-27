import type { GitStatusInfo } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
} from "@yep-anywhere/shared";
import { resetRouteRetentionForTests } from "../../lib/routeRetention";
import type { Project } from "../../types";
import { GitStatusPage } from "../GitStatusPage";

const mocks = vi.hoisted(() => ({
  checkGitRemote: vi.fn(),
  listReviewComments: vi.fn(),
  useProjects: vi.fn(),
  useProject: vi.fn(),
  useVersion: vi.fn(),
  useGitStatus: vi.fn(),
  useNavigationLayout: vi.fn(),
  useMediaQuery: vi.fn(),
  renderCommitBrowser: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    listReviewComments: mocks.listReviewComments,
    checkGitRemote: mocks.checkGitRemote,
    pullGit: vi.fn(),
    pushGit: vi.fn(),
  },
}));

vi.mock("../CommitBrowser", async () => {
  const { useSourceReviewDefaultSession } = await import(
    "../../contexts/SourceReviewDefaultSessionContext"
  );
  return {
    CommitBrowser: (props: {
      status: GitStatusInfo;
      initialWorkingTreePath?: string;
    }) => {
      mocks.renderCommitBrowser({
        ...props,
        defaultSession: useSourceReviewDefaultSession(),
      });
      return (
        <div data-testid="commit-browser">
          {props.status.isClean ? "clean-history" : "dirty-history"}
        </div>
      );
    },
  };
});

vi.mock("../../hooks/useDocumentTitle", () => ({
  useDocumentTitle: vi.fn(),
}));

vi.mock("../../hooks/useGitStatus", () => ({
  useGitStatus: mocks.useGitStatus,
}));

vi.mock("../../hooks/useMediaQuery", () => ({
  useMediaQuery: mocks.useMediaQuery,
}));

vi.mock("../../hooks/useProjects", () => ({
  useProject: mocks.useProject,
  useProjects: mocks.useProjects,
}));

vi.mock("../../hooks/useRelativeNow", () => ({
  useRelativeNow: () => 0,
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: mocks.useVersion,
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string | number>) =>
      vars ? `${key} ${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock("../../layouts", () => ({
  MainContent: ({
    children,
    innerClassName,
  }: {
    children: ReactNode;
    innerClassName?: string;
  }) => <div className={innerClassName}>{children}</div>,
  useNavigationLayout: mocks.useNavigationLayout,
}));

function project(): Project {
  return {
    id: "project-a",
    name: "Project A",
    path: "/repo/project-a",
    sessionCount: 1,
    activeOwnedCount: 0,
    activeExternalCount: 0,
    projectQueueBlockingCount: 0,
    lastActivity: "2026-06-30T00:00:00.000Z",
  };
}

function status(): GitStatusInfo {
  return {
    isGitRepo: true,
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    isClean: false,
    files: [
      {
        path: "a.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
      {
        path: "b.ts",
        status: "A",
        staged: true,
        linesAdded: 3,
        linesDeleted: 0,
      },
    ],
    recentCommits: [],
    checkedRemoteAt: null,
  };
}

function renderPage(
  initialEntry:
    | string
    | {
        pathname: string;
        search: string;
        state: unknown;
      } = "/git-status?projectId=project-a",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/git-status" element={<GitStatusPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetRouteRetentionForTests();
  mocks.checkGitRemote.mockReset();
  mocks.listReviewComments.mockReset();
  mocks.listReviewComments.mockResolvedValue({
    comments: [],
    batches: [],
    pendingCount: 0,
  });
  mocks.checkGitRemote.mockResolvedValue({
    status: "checked",
    checkedRemoteAt: "2026-07-26T12:00:00.000Z",
  });
  mocks.useProjects.mockReturnValue({
    projects: [project()],
    loading: false,
  });
  mocks.useProject.mockReturnValue({ project: project() });
  mocks.useVersion.mockReturnValue({
    version: {
      capabilities: [
        GIT_STATUS_ENHANCED_CAPABILITY,
        GIT_STATUS_REMOTE_CHECK_CAPABILITY,
      ],
    },
    loading: false,
    error: null,
  });
  mocks.useGitStatus.mockReturnValue({
    gitStatus: status(),
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
  mocks.useNavigationLayout.mockReturnValue({
    openSidebar: vi.fn(),
    isWideScreen: true,
    isSidebarCollapsed: false,
    toggleSidebar: vi.fn(),
  });
  mocks.useMediaQuery.mockReturnValue(true);
  mocks.renderCommitBrowser.mockReset();
});

describe("GitStatusPage source header", () => {
  it("composes status, tabs, and the Review entry into one tablet/desktop row", async () => {
    renderPage();
    await screen.findByTestId("commit-browser");
    await waitFor(() =>
      expect(mocks.listReviewComments).toHaveBeenCalledWith("project-a"),
    );

    const header = document.querySelector(".session-header") as HTMLElement;
    expect(header.querySelectorAll(".repo-status-bar")).toHaveLength(1);
    expect(header.querySelector(".source-mode-tabs")).not.toBeNull();
    expect(header.querySelector(".review-tray-button")?.textContent).toContain(
      "sourceReviewStart",
    );
    expect(document.querySelector(".git-status > .repo-status-bar")).toBeNull();
  });

  it("lands on Commits and treats a legacy Changes URL as Commits", async () => {
    renderPage("/git-status?projectId=project-a&tab=changes");

    expect(await screen.findByTestId("commit-browser")).toBeDefined();
    expect(
      screen
        .getByRole("tab", { name: "sourceTabCommits" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByRole("tab", { name: "sourceTabChanges" })).toBeNull();
  });

  it("uses the Edit-link history entry as the tab-local default session", async () => {
    const defaultSession = {
      projectId: "project-a",
      id: "session-origin",
      title: "Fix polling",
      newSession: {
        provider: "codex" as const,
        model: "gpt-5.4",
        thinking: { type: "adaptive" as const, display: "summarized" as const },
        effort: "high" as const,
      },
    };
    renderPage({
      pathname: "/git-status",
      search: "?projectId=project-a&worktreeFile=a.ts",
      state: { defaultSession },
    });

    await screen.findByTestId("commit-browser");
    expect(mocks.renderCommitBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialWorkingTreePath: "a.ts",
        defaultSession,
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "sourceTabComments" }));
    fireEvent.click(screen.getByRole("tab", { name: "sourceTabCommits" }));
    await screen.findByTestId("commit-browser");
    expect(mocks.renderCommitBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultSession }),
    );
  });

  it("shows successful remote-check feedback on the Check button", async () => {
    renderPage();
    const check = await screen.findByRole("button", {
      name: "gitStatusCheckRemoteShort",
    });
    fireEvent.click(check);

    expect(
      await screen.findByRole("button", {
        name: /gitStatusCheckRemoteShort: gitStatusRemoteCheckSuccess/,
      }),
    ).toBeDefined();
  });

  it("keeps mobile source controls in scrolling content", async () => {
    mocks.useMediaQuery.mockReturnValue(false);
    mocks.useNavigationLayout.mockReturnValue({
      openSidebar: vi.fn(),
      isWideScreen: false,
      isSidebarCollapsed: false,
      toggleSidebar: vi.fn(),
    });
    renderPage();
    await waitFor(() =>
      expect(mocks.listReviewComments).toHaveBeenCalledWith("project-a"),
    );

    const header = document.querySelector(".session-header") as HTMLElement;
    expect(header.querySelector(".repo-status-bar")).toBeNull();
    expect(
      document.querySelector(".git-status > .repo-status-bar"),
    ).not.toBeNull();
  });
});
