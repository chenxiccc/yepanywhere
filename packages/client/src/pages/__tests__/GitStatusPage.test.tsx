import type { GitStatusInfo } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
} from "@yep-anywhere/shared";
import { resetRouteRetentionForTests } from "../../lib/routeRetention";
import type { Project } from "../../types";
import { GitStatusPage } from "../GitStatusPage";

const mocks = vi.hoisted(() => ({
  checkGitRemote: vi.fn(),
  getGitIntegrationOptions: vi.fn(),
  listReviewComments: vi.fn(),
  pullGit: vi.fn(),
  pushGit: vi.fn(),
  useProjects: vi.fn(),
  useProject: vi.fn(),
  useVersion: vi.fn(),
  useGitStatus: vi.fn(),
  useNavigationLayout: vi.fn(),
  useMediaQuery: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    listReviewComments: mocks.listReviewComments,
    checkGitRemote: mocks.checkGitRemote,
    getGitIntegrationOptions: mocks.getGitIntegrationOptions,
    pullGit: mocks.pullGit,
    pushGit: mocks.pushGit,
  },
}));

vi.mock("../CommitBrowser", () => ({
  CommitBrowser: ({ status }: { status: GitStatusInfo }) => (
    <div data-testid="commit-browser">
      {status.isClean ? "clean-history" : "dirty-history"}
    </div>
  ),
}));

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
  initialEntry = "/git-status?projectId=project-a",
) {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/git-status" element={<GitStatusPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

const RELEASED_BASIC_GIT_CAPABILITIES = [
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
] as const;

const CORE_GIT_COMPATIBILITY_RELEASES = [
  { version: "v0.6.0", releasedAt: "2026-07-06" },
  { version: "v0.6.1", releasedAt: "2026-07-10" },
  { version: "v0.6.2", releasedAt: "2026-07-11" },
  { version: "v0.7.0", releasedAt: "2026-07-25" },
] as const;

beforeEach(() => {
  resetRouteRetentionForTests();
  mocks.checkGitRemote.mockReset();
  mocks.getGitIntegrationOptions.mockReset();
  mocks.listReviewComments.mockReset();
  mocks.pullGit.mockReset();
  mocks.pushGit.mockReset();
  mocks.listReviewComments.mockResolvedValue({
    comments: [],
    batches: [],
    pendingCount: 0,
  });
  mocks.checkGitRemote.mockResolvedValue({
    status: "checked",
    checkedRemoteAt: "2026-07-26T12:00:00.000Z",
  });
  mocks.getGitIntegrationOptions.mockResolvedValue({
    status: "available",
    checkedRemoteAt: "2026-07-26T12:00:00.000Z",
    gitStatus: status(),
    canAutoRebase: true,
    canAutoMerge: true,
    reasons: [],
    ahead: 1,
    behind: 1,
    upstream: "origin/main",
    isClean: true,
    hasSequencerState: false,
  });
  mocks.pullGit.mockResolvedValue({
    status: "pulled",
    checkedRemoteAt: "2026-07-26T12:00:00.000Z",
    gitStatus: status(),
  });
  mocks.pushGit.mockResolvedValue({
    status: "pushed",
    checkedRemoteAt: "2026-07-26T12:00:00.000Z",
    gitStatus: status(),
  });
  mocks.useProjects.mockReturnValue({
    projects: [project()],
    loading: false,
  });
  mocks.useProject.mockReturnValue({ project: project() });
  mocks.useVersion.mockReturnValue({
    version: {
      capabilities: [
        GIT_SOURCE_REVIEW_CAPABILITY,
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
      screen.getByRole("tab", { name: "sourceTabCommits" }).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    expect(screen.queryByRole("tab", { name: "sourceTabChanges" })).toBeNull();
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
    expect(
      screen.getByRole("status").textContent,
    ).toBe("gitStatusRemoteCheckSuccess");
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

describe("GitStatusPage released-server compatibility", () => {
  it.each(CORE_GIT_COMPATIBILITY_RELEASES)(
    "keeps basic Source Control for $version ($releasedAt)",
    async () => {
      mocks.useVersion.mockReturnValue({
        version: { capabilities: [...RELEASED_BASIC_GIT_CAPABILITIES] },
        loading: false,
        error: null,
      });

      renderPage();

      expect(
        await screen.findByText("gitStatusCompatibilityTitle"),
      ).toBeDefined();
      expect(
        screen.getByText("gitStatusCompatibilityDescription"),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "gitStatusPull" }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "gitStatusPush" }),
      ).toBeDefined();
      expect(
        screen.getByRole("button", { name: "gitStatusCheckRemote" }),
      ).toBeDefined();
      expect(screen.queryByTestId("commit-browser")).toBeNull();
      expect(document.querySelector(".source-mode-tabs")).toBeNull();
      expect(document.querySelector(".review-tray-button")).toBeNull();
      expect(mocks.listReviewComments).not.toHaveBeenCalled();
    },
  );

  it("shows a persistent full-text divergence warning", async () => {
    const divergedStatus = {
      ...status(),
      ahead: 2,
      behind: 1,
      isClean: true,
    };
    mocks.useVersion.mockReturnValue({
      version: { capabilities: [...RELEASED_BASIC_GIT_CAPABILITIES] },
      loading: false,
      error: null,
    });
    mocks.useGitStatus.mockReturnValue({
      gitStatus: divergedStatus,
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mocks.pullGit.mockResolvedValue({
      status: "failed",
      checkedRemoteAt: "2026-07-26T12:00:00.000Z",
      gitStatus: divergedStatus,
    });
    mocks.getGitIntegrationOptions.mockResolvedValue({
      status: "available",
      checkedRemoteAt: "2026-07-26T12:00:00.000Z",
      gitStatus: divergedStatus,
      canAutoRebase: true,
      canAutoMerge: true,
      reasons: [],
      ahead: 2,
      behind: 1,
      upstream: "origin/main",
      isClean: true,
      hasSequencerState: false,
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "gitStatusPull" }),
    );

    const warning = await screen.findByRole("alert");
    expect(warning.textContent).toContain("gitStatusPullDiverged");
    expect(warning.textContent).toContain('"ahead":2');
    expect(warning.textContent).toContain('"behind":1');
    expect(
      await screen.findByText("gitStatusAutoOptionsLabel"),
    ).toBeDefined();
  });
});
