import type { GitStatusInfo } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
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
  renderWorkingTreeBrowser: vi.fn(),
  renderCommitBrowser: vi.fn(),
  renderBlameBrowser: vi.fn(),
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
  CommitBrowser: (props: { initialSha?: string }) => {
    mocks.renderCommitBrowser(props);
    return <div data-testid="commit-browser">commit-history</div>;
  },
}));

vi.mock("../BlameBrowser", () => ({
  BlameBrowser: (props: {
    initialPath?: string;
    onOpenCommit?: (sha: string) => void;
  }) => {
    mocks.renderBlameBrowser(props);
    return (
      <div data-testid="blame-browser">
        <button
          type="button"
          onClick={() => props.onOpenCommit?.("b".repeat(40))}
        >
          open-blame-commit
        </button>
      </div>
    );
  },
}));

vi.mock("../WorkingTreeBrowser", async () => {
  const { useSourceReviewDefaultSession } = await import(
    "../../contexts/SourceReviewDefaultSessionContext"
  );
  return {
    WorkingTreeBrowser: (props: {
      status: GitStatusInfo;
      initialWorkingTreePath?: string;
      ignoreWhitespace?: boolean;
      onToggleIgnoreWhitespace?: () => void;
      onBrowseHistory?: () => void;
    }) => {
      mocks.renderWorkingTreeBrowser({
        ...props,
        defaultSession: useSourceReviewDefaultSession(),
      });
      return (
        <div data-testid="working-tree-browser">
          {props.status.isClean ? "clean-changes" : "dirty-changes"}
          <button type="button" onClick={props.onToggleIgnoreWhitespace}>
            gitStatusIgnoreWhitespace
          </button>
          <button type="button" onClick={props.onBrowseHistory}>
            sourceCommitHistory
          </button>
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
        GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
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
  mocks.renderWorkingTreeBrowser.mockReset();
});

describe("GitStatusPage source header", () => {
  it("keeps identity and tabs in the header with actions in their own row", async () => {
    renderPage();
    await screen.findByTestId("working-tree-browser");
    await waitFor(() =>
      expect(mocks.listReviewComments).toHaveBeenCalledWith("project-a"),
    );

    const header = document.querySelector(".session-header") as HTMLElement;
    expect(header.querySelectorAll(".repo-status-bar")).toHaveLength(1);
    expect(header.querySelector(".source-mode-tabs")).not.toBeNull();
    expect(header.querySelectorAll(".source-mode-tab")).toHaveLength(3);
    expect(header.querySelector(".review-tray-button")).toBeNull();

    const actionRow = document.querySelector(
      ".source-control-action-row",
    ) as HTMLElement;
    expect(actionRow).not.toBeNull();
    expect(actionRow.querySelector(".review-tray-button")?.textContent).toContain(
      "sourceReviewStart",
    );
    expect(document.querySelector(".git-status > .repo-status-bar")).toBeNull();
  });

  it("lands on Changes and keeps its URL as the default", async () => {
    renderPage();

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(
      screen
        .getByRole("tab", { name: /sourceTabChanges/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.queryByTestId("commit-browser")).toBeNull();
  });

  it("gates diff projections without blocking ordinary Source Control", async () => {
    mocks.useVersion.mockReturnValue({
      version: {
        capabilities: [
          GIT_SOURCE_REVIEW_CAPABILITY,
          GIT_STATUS_ENHANCED_CAPABILITY,
        ],
      },
      loading: false,
      error: null,
    });
    renderPage();

    await screen.findByTestId("working-tree-browser");
    fireEvent.click(
      screen.getByRole("button", { name: "gitStatusIgnoreWhitespace" }),
    );

    expect(await screen.findByText("sourceProjectionUpgradeNotice")).toBeDefined();
    expect(mocks.renderWorkingTreeBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ ignoreWhitespace: false }),
    );
    expect(screen.getByTestId("working-tree-browser")).toBeDefined();
  });

  it("enables the whitespace projection when the server advertises it", async () => {
    renderPage();
    await screen.findByTestId("working-tree-browser");

    fireEvent.click(
      screen.getByRole("button", { name: "gitStatusIgnoreWhitespace" }),
    );

    await waitFor(() =>
      expect(mocks.renderWorkingTreeBrowser).toHaveBeenLastCalledWith(
        expect.objectContaining({ ignoreWhitespace: true }),
      ),
    );
    expect(screen.queryByText("sourceProjectionUpgradeNotice")).toBeNull();
  });

  it("opens history inside Changes and keeps legacy commit URLs working", async () => {
    renderPage();
    await screen.findByTestId("working-tree-browser");

    fireEvent.click(screen.getByText("sourceCommitHistory"));

    expect(await screen.findByTestId("commit-browser")).toBeDefined();
    expect(
      screen
        .getByRole("tab", { name: /sourceTabChanges/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(
      screen.queryByRole("tab", { name: "sourceTabCommits" }),
    ).toBeNull();
  });

  it("maps legacy commit URLs to history inside Changes", async () => {
    renderPage("/git-status?projectId=project-a&tab=commits");

    expect(await screen.findByTestId("commit-browser")).toBeDefined();
    expect(
      screen
        .getByRole("tab", { name: /sourceTabChanges/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("opens an asynchronously populated Files hash in commit history", async () => {
    renderPage("/git-status?projectId=project-a&tab=files&bf=src%2Fx.ts");

    expect(await screen.findByTestId("blame-browser")).toBeDefined();
    expect(mocks.renderBlameBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialPath: "src/x.ts" }),
    );

    fireEvent.click(screen.getByText("open-blame-commit"));

    expect(await screen.findByTestId("commit-browser")).toBeDefined();
    expect(
      screen
        .getByRole("tab", { name: /sourceTabChanges/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(mocks.renderCommitBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ initialSha: "b".repeat(40) }),
    );
  });

  it("makes the Dirty badge return to Changes", async () => {
    renderPage("/git-status?projectId=project-a&history=1");
    await screen.findByTestId("commit-browser");

    fireEvent.click(screen.getByTitle("sourceOpenChanges"));

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(screen.queryByTestId("commit-browser")).toBeNull();
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

    await screen.findByTestId("working-tree-browser");
    expect(mocks.renderWorkingTreeBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialWorkingTreePath: "a.ts",
        defaultSession,
      }),
    );

    fireEvent.click(screen.getByRole("tab", { name: "sourceTabComments" }));
    fireEvent.click(screen.getByRole("tab", { name: /sourceTabChanges/ }));
    await screen.findByTestId("working-tree-browser");
    expect(mocks.renderWorkingTreeBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ defaultSession }),
    );
  });

  it("shows remote-check feedback without changing the visible button label", async () => {
    let resolveCheck:
      | ((value: {
          status: "checked";
          checkedRemoteAt: string;
        }) => void)
      | undefined;
    mocks.checkGitRemote.mockReturnValue(
      new Promise((resolve) => {
        resolveCheck = resolve;
      }),
    );
    renderPage();
    const check = await screen.findByRole("button", {
      name: "gitStatusCheckRemote",
    });
    expect(check.textContent).toBe("gitStatusCheckRemote");
    expect(check.querySelector(".git-status-action-glyph")).not.toBeNull();
    fireEvent.click(check);

    const checking = await screen.findByRole("button", {
      name: "gitStatusCheckRemote: gitStatusCheckingRemote",
    });
    expect(checking.textContent).toBe("gitStatusCheckRemote");
    expect(checking.querySelector(".git-status-action-glyph")).toBeNull();
    expect(checking.classList.contains("git-status-action-running")).toBe(true);

    resolveCheck?.({
      status: "checked",
      checkedRemoteAt: "2026-07-26T12:00:00.000Z",
    });
    const completed = await screen.findByRole("button", {
      name: /gitStatusCheckRemote: gitStatusRemoteCheckSuccess/,
    });
    await waitFor(() =>
      expect(completed.textContent).toBe("✓gitStatusCheckRemote"),
    );
    expect(screen.getByRole("status").textContent).toBe(
      "gitStatusRemoteCheckSuccess",
    );
  });

  it("keeps mobile identity in the header and stacks tabs with actions", async () => {
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
    expect(header.querySelector(".repo-status-bar")).not.toBeNull();
    expect(header.querySelector(".source-mode-tabs")).toBeNull();
    expect(
      document.querySelector(".source-control-mobile-tabs .source-mode-tabs"),
    ).not.toBeNull();
    expect(
      document.querySelector(".source-control-action-row"),
    ).not.toBeNull();
  });
});

describe("GitStatusPage released-server compatibility", () => {
  it.each(
    CORE_GIT_COMPATIBILITY_RELEASES,
  )("keeps basic Source Control for $version ($releasedAt)", async () => {
    mocks.useVersion.mockReturnValue({
      version: { capabilities: [...RELEASED_BASIC_GIT_CAPABILITIES] },
      loading: false,
      error: null,
    });

    renderPage();

    expect(
      await screen.findByText("gitStatusCompatibilityTitle"),
    ).toBeDefined();
    expect(screen.getByText("gitStatusCompatibilityDescription")).toBeDefined();
    expect(screen.getByRole("button", { name: "gitStatusPull" })).toBeDefined();
    expect(screen.getByRole("button", { name: "gitStatusPush" })).toBeDefined();
    expect(
      screen.getByRole("button", { name: "gitStatusCheckRemote" }),
    ).toBeDefined();
    expect(screen.queryByTestId("commit-browser")).toBeNull();
    expect(document.querySelector(".source-mode-tabs")).toBeNull();
    expect(document.querySelector(".review-tray-button")).toBeNull();
    expect(mocks.listReviewComments).not.toHaveBeenCalled();
  });

  it.each(
    CORE_GIT_COMPATIBILITY_RELEASES,
  )("keeps generic action feedback for $version ($releasedAt)", async () => {
    mocks.useVersion.mockReturnValue({
      version: { capabilities: [...RELEASED_BASIC_GIT_CAPABILITIES] },
      loading: false,
      error: null,
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "gitStatusPull" }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "gitStatusPullSuccess",
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "gitStatusPush" }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "gitStatusPushSuccess",
    );
  });

  it("shows commit counts supplied by a current server", async () => {
    mocks.useVersion.mockReturnValue({
      version: { capabilities: [...RELEASED_BASIC_GIT_CAPABILITIES] },
      loading: false,
      error: null,
    });
    mocks.pullGit.mockResolvedValue({
      status: "pulled",
      checkedRemoteAt: "2026-07-31T12:00:00.000Z",
      gitStatus: status(),
      commitsAdvanced: 2,
    });
    mocks.pushGit.mockResolvedValue({
      status: "pushed",
      checkedRemoteAt: "2026-07-31T12:00:00.000Z",
      gitStatus: status(),
      commitsAdvanced: 1,
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "gitStatusPull" }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      'gitStatusPullSuccessMultiple {"count":2}',
    );

    fireEvent.click(
      await screen.findByRole("button", { name: "gitStatusPush" }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      'gitStatusPushSuccessSingle {"count":1}',
    );
  });

  it("reports an unchanged pull as already up to date", async () => {
    mocks.useVersion.mockReturnValue({
      version: { capabilities: [...RELEASED_BASIC_GIT_CAPABILITIES] },
      loading: false,
      error: null,
    });
    mocks.pullGit.mockResolvedValue({
      status: "pulled",
      checkedRemoteAt: "2026-07-31T12:00:00.000Z",
      gitStatus: status(),
      commitsAdvanced: 0,
    });

    renderPage();
    fireEvent.click(
      await screen.findByRole("button", { name: "gitStatusPull" }),
    );
    expect((await screen.findByRole("status")).textContent).toContain(
      "gitStatusPullAlreadyUpToDate",
    );
  });

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
    expect(await screen.findByText("gitStatusAutoOptionsLabel")).toBeDefined();
  });
});
