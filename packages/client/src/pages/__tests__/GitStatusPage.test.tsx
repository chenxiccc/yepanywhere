import type { GitStatusInfo } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GIT_STATUS_ENHANCED_CAPABILITY } from "@yep-anywhere/shared";
import { resetRouteRetentionForTests } from "../../lib/routeRetention";
import type { Project } from "../../types";
import { GitStatusPage } from "../GitStatusPage";

const mocks = vi.hoisted(() => ({
  getGitDiff: vi.fn(),
  getGitUntrackedFolder: vi.fn(),
  listReviewComments: vi.fn(),
  useProjects: vi.fn(),
  useProject: vi.fn(),
  useVersion: vi.fn(),
  useGitStatus: vi.fn(),
  useNavigationLayout: vi.fn(),
  useMediaQuery: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getGitDiff: mocks.getGitDiff,
    getGitUntrackedFolder: mocks.getGitUntrackedFolder,
    listReviewComments: mocks.listReviewComments,
    checkGitRemote: vi.fn(),
    pullGit: vi.fn(),
    pushGit: vi.fn(),
  },
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

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/git-status?projectId=project-a"]}>
      <Routes>
        <Route path="/git-status" element={<GitStatusPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetRouteRetentionForTests();
  mocks.getGitDiff.mockReset();
  mocks.getGitUntrackedFolder.mockReset();
  mocks.listReviewComments.mockReset();
  mocks.listReviewComments.mockResolvedValue({
    comments: [],
    batches: [],
    pendingCount: 0,
  });
  mocks.getGitDiff.mockResolvedValue({
    diffHtml: "",
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-a", "+b"],
      },
    ],
  });
  mocks.getGitUntrackedFolder.mockResolvedValue({
    path: "packages/client/src/lib/transport/",
    files: [
      "packages/client/src/lib/transport/FakeSourceTransport.ts",
      "packages/client/src/lib/transport/types.ts",
    ],
    truncated: false,
    limit: 500,
  });
  mocks.useProjects.mockReturnValue({
    projects: [project()],
    loading: false,
  });
  mocks.useProject.mockReturnValue({ project: project() });
  mocks.useVersion.mockReturnValue({
    version: { capabilities: [GIT_STATUS_ENHANCED_CAPABILITY] },
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
    await screen.findByRole("button", { name: "gitStatusFullContext" });
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

describe("GitStatusPage route retention", () => {
  it("restores the selected file after the route remounts", async () => {
    const first = renderPage();
    await screen.findByRole("button", { name: "gitStatusFullContext" });
    fireEvent.click(screen.getByRole("button", { name: /b\.ts/ }));
    expect(
      screen
        .getByRole("button", { name: /b\.ts/ })
        .getAttribute("aria-current"),
    ).toBe("true");
    first.unmount();

    renderPage();
    await screen.findByRole("button", { name: "gitStatusFullContext" });

    expect(
      screen
        .getByRole("button", { name: /b\.ts/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });
});

describe("GitStatusPage diff preview guards", () => {
  it("shows server skipped-preview metadata instead of diff content", async () => {
    mocks.getGitDiff.mockResolvedValue({
      diffHtml: "",
      structuredPatch: [],
      previewSkipped: {
        reason: "line-too-long",
        totalBytes: 30_012,
        maxLineChars: 30_012,
        maxLineCharsLimit: 20_000,
      },
    });

    renderPage();

    expect(
      await screen.findByText("gitStatusDiffPreviewSkipped"),
    ).toBeDefined();
    expect(
      screen.getByText("gitStatusDiffPreviewSkippedLineTooLong"),
    ).toBeDefined();
    expect(
      screen.getByText("gitStatusDiffPreviewSkippedLineLength"),
    ).toBeDefined();
  });

  it("does not inject oversized highlighted diff html", async () => {
    mocks.getGitDiff.mockResolvedValue({
      diffHtml: "x".repeat(1_000_001),
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-a", "+b"],
        },
      ],
    });

    renderPage();

    expect(
      await screen.findByText("gitStatusDiffPreviewSkippedHtmlTooLarge"),
    ).toBeDefined();
  });
});

describe("GitStatusPage untracked folders", () => {
  it("opens an untracked folder listing without loading a diff", async () => {
    mocks.useGitStatus.mockReturnValue({
      gitStatus: {
        ...status(),
        files: [
          {
            path: "packages/client/src/lib/transport/",
            status: "?",
            staged: false,
            linesAdded: null,
            linesDeleted: null,
          },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();

    fireEvent.click(
      await screen.findByRole("button", {
        name: /packages\/client\/src\/lib\/transport\//,
      }),
    );

    expect(mocks.getGitDiff).not.toHaveBeenCalled();
    expect(mocks.getGitUntrackedFolder).toHaveBeenCalledWith(
      "project-a",
      "packages/client/src/lib/transport/",
    );
    expect(
      await screen.findByText(
        "packages/client/src/lib/transport/FakeSourceTransport.ts",
      ),
    ).toBeDefined();
  });
});
