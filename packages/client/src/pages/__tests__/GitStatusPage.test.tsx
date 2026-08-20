import type { GitStatusInfo } from "@yep-anywhere/shared";
import { type ReactNode, useContext } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GIT_INCOMING_COMMITS_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
  GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
  GIT_WORKING_TREE_FILES_CAPABILITY,
  GIT_WORKING_TREE_SECTIONS_CAPABILITY,
} from "@yep-anywhere/shared";
import selectorStyles from "../../components/ProjectSelector.module.css";
import { ProjectWorktreePauseContext } from "../../hooks/useProjectWorktree";
import { setSourceControlCleanLandingPreference } from "../../hooks/useSourceControlCleanLanding";
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
  useProjectWorktree: vi.fn(),
  useNavigationLayout: vi.fn(),
  useMediaQuery: vi.fn(),
  serverSettings: { sourceReviewSubmissionsEnabled: false },
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
  CommitBrowser: (props: {
    initialPath?: string;
    initialSha?: string;
    showRevisionPane?: boolean;
    onBrowseHistory?: () => void;
    onSelectRevision?: (sha: string | null) => void;
  }) => {
    mocks.renderCommitBrowser(props);
    return (
      <div data-testid="commit-browser">
        commit-history
        <button type="button" onClick={props.onBrowseHistory}>
          sourceCommitHistory
        </button>
        <button
          type="button"
          onClick={() => props.onSelectRevision?.("next-sha")}
        >
          select-next-revision
        </button>
      </div>
    );
  },
}));

vi.mock("../BlameBrowser", () => ({
  BlameBrowser: (props: {
    initialPath?: string;
    onOpenCommit?: (sha: string) => void;
  }) => {
    const worktreePaused = useContext(ProjectWorktreePauseContext);
    mocks.renderBlameBrowser(props);
    return (
      <div data-testid="blame-browser" data-worktree-paused={worktreePaused}>
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
      supportsLastEditor?: boolean;
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

vi.mock("../../hooks/useProjectWorktree", async (original) => ({
  ...(await original<typeof import("../../hooks/useProjectWorktree")>()),
  useProjectWorktree: mocks.useProjectWorktree,
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

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({ settings: mocks.serverSettings }),
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

function NavigationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="test-location">
        {location.pathname}
        {location.search}
      </div>
      <button type="button" onClick={() => navigate(-1)}>
        testBrowserBack
      </button>
    </>
  );
}

function renderPage(
  initialEntry:
    | string
    | {
        pathname: string;
        search: string;
        state: unknown;
      } = "/git-status?projectId=project-a",
  precedingEntry?: string,
) {
  const initialEntries = precedingEntry
    ? [precedingEntry, initialEntry]
    : [initialEntry];
  return render(
    <MemoryRouter
      initialEntries={initialEntries}
      initialIndex={initialEntries.length - 1}
    >
      <Routes>
        <Route
          path="/git-status"
          element={
            <>
              <GitStatusPage />
              <NavigationProbe />
            </>
          }
        />
        <Route path="/previous" element={<div>previous-page</div>} />
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
  localStorage.clear();
  setSourceControlCleanLandingPreference("working-tree");
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
  mocks.serverSettings.sourceReviewSubmissionsEnabled = false;
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
        GIT_DIRTY_FILE_EDITOR_CAPABILITY,
        GIT_INCOMING_COMMITS_CAPABILITY,
        GIT_STATUS_ENHANCED_CAPABILITY,
        GIT_STATUS_REMOTE_CHECK_CAPABILITY,
        GIT_WORKING_TREE_FILES_CAPABILITY,
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
  mocks.useProjectWorktree.mockReset();
  mocks.useProjectWorktree.mockReturnValue({
    loading: false,
    error: null,
    generation: null,
    headSha: null,
    baseSha: null,
    files: [],
    directories: [],
    truncated: false,
  });
  mocks.useNavigationLayout.mockReturnValue({
    openSidebar: vi.fn(),
    isWideScreen: true,
    isSidebarCollapsed: false,
    toggleSidebar: vi.fn(),
  });
  mocks.useMediaQuery.mockReturnValue(true);
  mocks.renderWorkingTreeBrowser.mockReset();
  mocks.renderCommitBrowser.mockReset();
  mocks.renderBlameBrowser.mockReset();
});

describe("GitStatusPage source header", () => {
  it("keeps identity, tabs, and fallback repository actions in the header", async () => {
    renderPage();
    await screen.findByTestId("working-tree-browser");
    await waitFor(() =>
      expect(mocks.listReviewComments).toHaveBeenCalledWith("project-a"),
    );

    const header = document.querySelector(".session-header") as HTMLElement;
    expect(
      header.querySelectorAll('[data-testid="repo-status-bar"]'),
    ).toHaveLength(1);
    expect(header.querySelector('[role="tablist"]')).not.toBeNull();
    expect(header.querySelectorAll('[role="tab"]')).toHaveLength(3);
    expect(screen.getByRole("button", { name: "→ origin/main" })).toBeDefined();

    const actions = header.querySelector(
      '[data-source-actions-placement="fallback"]',
    ) as HTMLElement;
    expect(actions).not.toBeNull();
    expect(
      screen.queryByRole("button", { name: "sourceCommentsAction" }),
    ).toBeNull();
    expect(
      screen.getByRole("tab", { name: /sourceTabComments/ }),
    ).toBeDefined();
    expect(document.querySelector(".source-control-action-row")).toBeNull();
    expect(
      document.querySelector('.git-status > [data-testid="repo-status-bar"]'),
    ).toBeNull();
  });

  it("uses the title row only while the rendered repository actions fit", async () => {
    mocks.useVersion.mockReturnValue({
      version: {
        capabilities: [
          GIT_SOURCE_REVIEW_CAPABILITY,
          GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
          GIT_DIRTY_FILE_EDITOR_CAPABILITY,
          GIT_STATUS_ENHANCED_CAPABILITY,
          GIT_STATUS_PULL_CAPABILITY,
          GIT_STATUS_PUSH_CAPABILITY,
          GIT_STATUS_REMOTE_CHECK_CAPABILITY,
        ],
      },
      loading: false,
      error: null,
    });

    let headerWidth = 900;
    let notifyResize: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          notifyResize = () => callback([], this as unknown as ResizeObserver);
        }

        observe() {}
        disconnect() {}
        unobserve() {}
      },
    );

    const widthOf = (element: HTMLElement) => {
      const parent = element.parentElement;
      if (parent?.matches("[data-source-action-group]")) return 80;
      if (parent?.getAttribute("role") === "tablist") return 72;
      if (parent?.classList.contains("session-header-left")) return 96;
      return 0;
    };
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return this.classList.contains("session-header-inner")
          ? headerWidth
          : widthOf(this);
      },
    );
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(
      function (this: HTMLElement) {
        return widthOf(this);
      },
    );
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const width = widthOf(this);
        return {
          bottom: 20,
          height: 20,
          left: 0,
          right: width,
          top: 0,
          width,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      },
    );

    try {
      renderPage();
      await screen.findByTestId("working-tree-browser");
      const header = document.querySelector(".session-header") as HTMLElement;
      expect(
        header.querySelector('[data-source-actions-placement="title"]'),
      ).not.toBeNull();
      expect(
        header.querySelectorAll("[data-source-action-group] > button"),
      ).toHaveLength(3);

      headerWidth = 360;
      act(() => notifyResize?.());

      expect(
        header.querySelector('[data-source-actions-placement="fallback"]'),
      ).not.toBeNull();
    } finally {
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it("opens Pending Comments even with pending drafts and preserves mode history", async () => {
    mocks.listReviewComments.mockResolvedValue({
      comments: [
        {
          id: "comment-1",
          status: "pending",
          text: "why?",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "a.ts",
            revision: { kind: "sha", sha: "a".repeat(40) },
            side: "new",
            oldLine: null,
            newLine: 1,
            snippet: "",
          },
        },
      ],
      batches: [],
      pendingCount: 1,
    });
    renderPage();

    await screen.findByTestId("working-tree-browser");
    fireEvent.click(
      await screen.findByRole("tab", { name: /sourceTabComments/ }),
    );

    expect(
      screen
        .getByRole("tab", { name: /sourceTabComments/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "testBrowserBack" }));

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(
      screen
        .getByRole("tab", { name: /sourceTabChanges/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("returns from Reviews to the preceding Source Control mode", async () => {
    mocks.serverSettings.sourceReviewSubmissionsEnabled = true;
    mocks.useVersion.mockReturnValue({
      version: {
        capabilities: [
          GIT_SOURCE_REVIEW_CAPABILITY,
          GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
          GIT_STATUS_ENHANCED_CAPABILITY,
        ],
      },
      loading: false,
      error: null,
    });
    renderPage();

    await screen.findByTestId("working-tree-browser");
    fireEvent.click(screen.getByRole("tab", { name: "sourceTabReviews" }));
    expect(await screen.findByText("sourceReviewNoSubmissions")).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "testBrowserBack" }));
    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
  });

  it("backs out of Source Control from a directly linked mode", async () => {
    renderPage("/git-status?projectId=project-a&tab=comments", "/previous");

    expect(
      (
        await screen.findByRole("tab", { name: /sourceTabComments/ })
      ).getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "testBrowserBack" }));

    expect(await screen.findByText("previous-page")).toBeDefined();
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

  it("lands on Working tree status when Changes is clean", async () => {
    mocks.useGitStatus.mockReturnValue({
      gitStatus: { ...status(), isClean: true, files: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(screen.queryByTestId("commit-browser")).toBeNull();
    expect(
      screen
        .getByRole("tab", { name: /sourceTabChanges/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("lands on the latest commit when the clean preference opts in", async () => {
    setSourceControlCleanLandingPreference("latest-commit");
    mocks.useGitStatus.mockReturnValue({
      gitStatus: { ...status(), isClean: true, files: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });

    renderPage();

    expect(await screen.findByTestId("commit-browser")).toBeDefined();
    expect(screen.queryByTestId("working-tree-browser")).toBeNull();
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

    expect(
      await screen.findByText("sourceProjectionUpgradeNotice"),
    ).toBeDefined();
    expect(mocks.renderWorkingTreeBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ ignoreWhitespace: false }),
    );
    expect(screen.getByTestId("working-tree-browser")).toBeDefined();
  });

  it("gates dirty-file session links independently", async () => {
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
    expect(mocks.renderWorkingTreeBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ supportsLastEditor: false }),
    );
  });

  it("enables dirty-file session links when advertised", async () => {
    renderPage();

    await screen.findByTestId("working-tree-browser");
    expect(mocks.renderWorkingTreeBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ supportsLastEditor: true }),
    );
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
    expect(screen.queryByRole("tab", { name: "sourceTabCommits" })).toBeNull();
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

  it("keeps Reviews dormant until the new capability and setting land", async () => {
    renderPage("/git-status?projectId=project-a&tab=reviews");

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(screen.queryByRole("tab", { name: "sourceTabReviews" })).toBeNull();
  });

  it("shows Reviews only when capability and persisted opt-in are both present", async () => {
    mocks.serverSettings.sourceReviewSubmissionsEnabled = true;
    mocks.useVersion.mockReturnValue({
      version: {
        capabilities: [
          GIT_SOURCE_REVIEW_CAPABILITY,
          GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
          GIT_STATUS_ENHANCED_CAPABILITY,
        ],
      },
      loading: false,
      error: null,
    });
    mocks.listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    renderPage("/git-status?projectId=project-a&tab=reviews");

    expect(
      await screen.findByRole("tab", { name: "sourceTabReviews" }),
    ).toBeDefined();
    expect(await screen.findByText("sourceReviewNoSubmissions")).toBeDefined();
  });

  it("opens an asynchronously populated Files hash in commit history", async () => {
    renderPage("/git-status?projectId=project-a&tab=files&bf=src%2Fx.ts");

    expect(await screen.findByTestId("blame-browser")).toBeDefined();
    expect(
      screen.getByRole("tab", { name: "sourceTabWorkingTree" }),
    ).toBeDefined();
    expect(mocks.renderBlameBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialPath: "src/x.ts",
        status: expect.objectContaining({ branch: "main" }),
        supportsWorkingTreeFiles: true,
      }),
    );

    fireEvent.click(screen.getByText("open-blame-commit"));

    expect(await screen.findByTestId("commit-browser")).toBeDefined();
    expect(
      screen
        .getByRole("tab", { name: /sourceTabChanges/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(mocks.renderCommitBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialSha: "b".repeat(40),
        showRevisionPane: false,
      }),
    );
  });

  it("pauses and resumes live Working Tree application from the header", async () => {
    mocks.useVersion.mockReturnValue({
      version: {
        capabilities: [
          GIT_SOURCE_REVIEW_CAPABILITY,
          GIT_STATUS_ENHANCED_CAPABILITY,
          GIT_WORKING_TREE_FILES_CAPABILITY,
          GIT_WORKING_TREE_SECTIONS_CAPABILITY,
        ],
      },
      loading: false,
      error: null,
    });
    renderPage("/git-status?projectId=project-a&tab=files");

    const browser = await screen.findByTestId("blame-browser");
    const pause = screen.getByRole("button", {
      name: "sourcePauseLiveUpdates",
      pressed: false,
    });
    expect(pause.querySelector(".git-status-action-glyph")).not.toBeNull();
    expect(pause.textContent).not.toMatch(/[Ⅱ▶]/);
    expect(browser.getAttribute("data-worktree-paused")).toBe("false");

    fireEvent.click(pause);
    const play = screen.getByRole("button", {
      name: "sourceResumeLiveUpdates",
      pressed: true,
    });
    expect(play.querySelector(".git-status-action-glyph")).not.toBeNull();
    expect(play.textContent).not.toMatch(/[Ⅱ▶]/);
    expect(browser.getAttribute("data-worktree-paused")).toBe("true");

    fireEvent.click(
      screen.getByRole("button", { name: "sourceResumeLiveUpdates" }),
    );
    expect(browser.getAttribute("data-worktree-paused")).toBe("false");
  });

  it("opens a linked file within the requested commit", async () => {
    renderPage(
      "/git-status?projectId=project-a&rev=abc123&commitFile=src%2Fx.ts",
    );

    expect(await screen.findByTestId("commit-browser")).toBeDefined();
    expect(mocks.renderCommitBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        initialSha: "abc123",
        initialPath: "src/x.ts",
        showRevisionPane: false,
      }),
    );
  });

  it("opens a focused commit's selector without losing the revision", async () => {
    renderPage("/git-status?projectId=project-a&rev=abc123");
    await screen.findByTestId("commit-browser");

    fireEvent.click(screen.getByText("sourceCommitHistory"));

    await waitFor(() =>
      expect(mocks.renderCommitBrowser).toHaveBeenLastCalledWith(
        expect.objectContaining({
          initialSha: "abc123",
          showRevisionPane: true,
        }),
      ),
    );
    expect(screen.getByTestId("test-location").textContent).toContain(
      "history=1",
    );
    expect(screen.getByTestId("test-location").textContent).toContain(
      "rev=abc123",
    );
  });

  it("keeps history selected when a revision row opens in place", async () => {
    renderPage("/git-status?projectId=project-a&history=1");
    await screen.findByTestId("commit-browser");

    fireEvent.click(screen.getByText("select-next-revision"));

    await waitFor(() =>
      expect(mocks.renderCommitBrowser).toHaveBeenLastCalledWith(
        expect.objectContaining({
          initialSha: "next-sha",
          showRevisionPane: true,
        }),
      ),
    );
    expect(screen.getByTestId("test-location").textContent).toContain(
      "history=1",
    );
    expect(screen.getByTestId("test-location").textContent).toContain(
      "rev=next-sha",
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
      | ((value: { status: "checked"; checkedRemoteAt: string }) => void)
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

  it("keeps one tab selector in the header at mobile width", async () => {
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

    // Placement is the wrapping header row's decision, so a narrow viewport
    // keeps the same single selector rather than growing a second one.
    const header = document.querySelector(".session-header") as HTMLElement;
    expect(
      header.querySelector('[data-testid="repo-status-bar"]'),
    ).not.toBeNull();
    expect(header.querySelector('[role="tablist"]')).not.toBeNull();
    expect(document.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(document.querySelector(".source-control-mobile-tabs")).toBeNull();
    expect(
      header.querySelector('[data-source-actions-placement="fallback"]'),
    ).not.toBeNull();
    expect(document.querySelector(".source-control-action-row")).toBeNull();
  });

  it("keeps the source-header hooks on a modular project selector", async () => {
    mocks.useProjects.mockReturnValue({
      projects: [project(), { ...project(), id: "project-b", name: "B" }],
      loading: false,
    });
    renderPage();
    await waitFor(() =>
      expect(mocks.listReviewComments).toHaveBeenCalledWith("project-a"),
    );

    const container = document.querySelector(
      ".project-selector-container",
    ) as HTMLElement;
    const trigger = container.querySelector("button") as HTMLElement;
    const text = trigger.querySelector("span") as HTMLElement;

    // The `.source-header-identity` rules in styles/index.css still reach
    // in by these literals, so each element carries both vocabularies.
    expect(container.className).toContain(selectorStyles.container);
    expect(trigger.className).toContain("project-selector-button");
    expect(trigger.className).toContain(selectorStyles.button);
    expect(text.className).toContain("project-selector-text");
    expect(text.className).toContain(selectorStyles.text);

    fireEvent.click(trigger);
    const dropdown = (await screen.findByRole("dialog", {
      name: "projectSelectorSelectProject",
    })) as HTMLElement;
    expect(dropdown.className).toContain(selectorStyles.dropdown);

    // The retired vocabulary is gone everywhere it was not an interop hook.
    for (const retired of [
      "project-selector-dropdown",
      "project-selector-options",
      "project-selector-option",
      "project-selector-name",
      "project-selector-meta",
      "project-selector-chevron",
    ]) {
      expect(document.querySelector(`.${retired}`)).toBeNull();
    }
  });
});

describe("GitStatusPage filesystem-only projects", () => {
  beforeEach(() => {
    mocks.useGitStatus.mockReturnValue({
      gitStatus: {
        ...status(),
        isGitRepo: false,
        branch: null,
        upstream: null,
        isClean: true,
        files: [],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
  });

  it("renders the live Working Tree without offering Git initialization", async () => {
    mocks.useVersion.mockReturnValue({
      version: {
        capabilities: [
          GIT_STATUS_ENHANCED_CAPABILITY,
          GIT_WORKING_TREE_SECTIONS_CAPABILITY,
          GIT_WORKING_TREE_COMPLETE_SCAN_CAPABILITY,
        ],
      },
      loading: false,
      error: null,
    });

    renderPage();

    expect(await screen.findByTestId("blame-browser")).toBeDefined();
    expect(mocks.renderBlameBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({
        projectId: "project-a",
        status: expect.objectContaining({ isGitRepo: false }),
        supportsWorktreeSections: true,
        supportsCompleteFilesystemScan: true,
      }),
    );
    expect(mocks.useProjectWorktree).toHaveBeenCalledWith(
      "project-a",
      { tracked: true, untracked: true, ignored: false },
      false,
      false,
    );
    expect(screen.queryByText("gitStatusNotRepo")).toBeNull();
    expect(screen.queryByRole("button", { name: /init/i })).toBeNull();
  });

  it("keeps complete filesystem scans unavailable without their capability", async () => {
    mocks.useVersion.mockReturnValue({
      version: {
        capabilities: [
          GIT_STATUS_ENHANCED_CAPABILITY,
          GIT_WORKING_TREE_SECTIONS_CAPABILITY,
        ],
      },
      loading: false,
      error: null,
    });

    renderPage();

    expect(await screen.findByTestId("blame-browser")).toBeDefined();
    expect(mocks.renderBlameBrowser).toHaveBeenLastCalledWith(
      expect.objectContaining({ supportsCompleteFilesystemScan: false }),
    );
  });

  it("keeps the not-repository fallback for older servers", async () => {
    mocks.useVersion.mockReturnValue({
      version: { capabilities: [GIT_STATUS_ENHANCED_CAPABILITY] },
      loading: false,
      error: null,
    });

    renderPage();

    expect(await screen.findByText("gitStatusNotRepo")).toBeDefined();
    expect(screen.queryByTestId("blame-browser")).toBeNull();
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
      expect(document.querySelector('[role="tablist"]')).toBeNull();
      expect(
        screen.queryByRole("button", { name: "sourceCommentsAction" }),
      ).toBeNull();
      expect(mocks.listReviewComments).not.toHaveBeenCalled();
    },
  );

  it.each(CORE_GIT_COMPATIBILITY_RELEASES)(
    "keeps generic action feedback for $version ($releasedAt)",
    async () => {
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
    },
  );

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
