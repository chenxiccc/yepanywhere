// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { GitStatusInfo, GitWorkingTreeFile } from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectWorktreePauseContext } from "../hooks/useProjectWorktree";
import { asClientSummarySourceKey } from "../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../lib/transport";

vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));
vi.mock("../i18n", async (orig) => ({
  ...(await orig<typeof import("../i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

const listGitFiles = vi.fn();
const listGitWorkingTreeFiles = vi.fn();
const getGitBlame = vi.fn();
const getFile = vi.fn();
const listReviewComments = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    listGitFiles: (...args: unknown[]) => listGitFiles(...args),
    listGitWorkingTreeFiles: (...args: unknown[]) =>
      listGitWorkingTreeFiles(...args),
    getFile: (...args: unknown[]) => getFile(...args),
    getFileRawUrl: () => "/raw/file",
    getGitBlame: (...args: unknown[]) => getGitBlame(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
  },
}));

import { BlameBrowser } from "./BlameBrowser";

const t = (key: string) => key;

function createRuntime(
  transport: FakeSourceTransport,
  sourceKey: string,
): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey(sourceKey),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

function withRuntime(runtime: YaSourceRuntime, children: ReactNode): ReactNode {
  return (
    <SourceRuntimeProvider runtime={runtime}>
      <MemoryRouter>{children}</MemoryRouter>
    </SourceRuntimeProvider>
  );
}

async function emitWorktreeSnapshot(
  transport: FakeSourceTransport,
  files: GitWorkingTreeFile[],
): Promise<void> {
  await waitFor(() =>
    expect(transport.getSubscriptions("worktree").length).toBeGreaterThan(0),
  );
  const subscription = transport.getSubscriptions("worktree").at(-1);
  if (!subscription) throw new Error("Expected worktree subscription");
  act(() => {
    transport.emitSubscriptionEvent(subscription.id, "git-worktree-snapshot", {
      type: "git-worktree-snapshot",
      generation: {
        epoch: "test-epoch",
        sequence: transport.getSubscriptions("worktree").length - 1,
      },
      coverage: subscription.coverage,
      headSha: "head-a",
      baseSha: "base-a",
      files,
      truncated: false,
      timestamp: "2026-08-19T00:00:00.000Z",
    });
  });
}

describe("BlameBrowser", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the first visible file in the wide master-detail view", async () => {
    listGitFiles.mockResolvedValue({
      files: ["src/first.ts", "src/second.ts"],
      truncated: false,
    });
    getGitBlame.mockResolvedValue({
      path: "src/first.ts",
      rev: "HEAD",
      lines: [],
      truncated: false,
    });
    getFile.mockResolvedValue({
      metadata: {
        path: "src/first.ts",
        size: 0,
        mimeType: "text/plain",
        isText: true,
      },
      content: "",
      rawUrl: "/raw/src/first.ts",
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <BlameBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(getGitBlame).toHaveBeenCalledWith("p1", "src/first.ts"),
    );
    expect(
      document
        .querySelector(".blame-file-item.selected")
        ?.textContent?.includes("src/first.ts"),
    ).toBe(true);

    const row = document.querySelector<HTMLButtonElement>(
      ".blame-file-item.selected",
    );
    expect(row).not.toBeNull();
    if (!row) throw new Error("Expected selected file row");
    fireEvent.contextMenu(row, { clientX: 32, clientY: 40 });
    expect(await screen.findByRole("menu")).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "sourceOpenFile" }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "sourceCopyPath" }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("separator", {
        name: "sourceResizeFilePane",
      }),
    ).toHaveLength(2);
  });

  it("finds a tracked file beyond the old 500-row rendering limit", async () => {
    const files = Array.from(
      { length: 650 },
      (_, index) => `src/file-${index.toString().padStart(3, "0")}.ts`,
    );
    const tail = "src/file-649.ts";
    listGitFiles.mockResolvedValue({ files, truncated: false });
    getGitBlame.mockResolvedValue({
      path: files[0],
      rev: "HEAD",
      lines: [],
      truncated: false,
    });
    getFile.mockResolvedValue({
      metadata: {
        path: files[0],
        size: 0,
        mimeType: "text/plain",
        isText: true,
      },
      content: "",
      rawUrl: `/raw/${files[0]}`,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <BlameBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText(files[0] as string);
    fireEvent.change(screen.getByPlaceholderText("sourceFilterFiles"), {
      target: { value: "file-649" },
    });

    await waitFor(() =>
      expect(
        document.querySelector(`[data-source-path="${tail}"]`),
      ).not.toBeNull(),
    );
    expect(screen.queryByText("sourceFilesTruncated")).toBeNull();
  });

  it("browses current dirty and unchanged content behind the new capability", async () => {
    const transport = new FakeSourceTransport();
    const runtime = createRuntime(transport, "test:blame-browser-live");
    const groupedCleanFiles = Array.from(
      { length: 12 },
      (_, index) =>
        `packages/client/file-${index.toString().padStart(3, "0")}.ts`,
    );
    const currentFiles: GitWorkingTreeFile[] = [
      { path: "README.md", tracked: true, kind: "tracked" },
      { path: "notes/new.txt", tracked: false, kind: "untracked" },
      ...groupedCleanFiles.map((path) => ({
        path,
        tracked: true,
        kind: "tracked" as const,
      })),
      {
        path: "src/live.ts",
        tracked: true,
        kind: "tracked",
        worktreeChanges: [
          {
            status: "M",
            staged: false,
            linesAdded: 1,
            linesDeleted: 0,
          },
        ],
      },
    ];
    getFile.mockImplementation((_projectId: string, path: string) =>
      Promise.resolve({
        metadata: {
          path,
          size: path.length,
          mimeType: "text/plain",
          isText: true,
        },
        content: `contents:${path}`,
        rawUrl: `/raw/${path}`,
      }),
    );
    getGitBlame.mockResolvedValue({
      path: "README.md",
      rev: "HEAD",
      lines: [],
      truncated: false,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const status: GitStatusInfo = {
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        {
          path: "src/live.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    };

    render(
      withRuntime(
        runtime,
        <BlameBrowser
          projectId="p1"
          isWideScreen={false}
          status={status}
          supportsWorkingTreeFiles
          supportsWorktreeSections
          t={t}
        />,
      ),
    );

    await emitWorktreeSnapshot(transport, currentFiles);
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);
    expect(transport.getSubscriptions("worktree")[0]).toMatchObject({
      projectId: "p1",
      coverage: { tracked: true, untracked: true, ignored: false },
    });
    expect(listGitWorkingTreeFiles).not.toHaveBeenCalled();
    expect(listGitFiles).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", { name: /sourceTrackedFiles/, pressed: true }),
    ).toBeDefined();
    const ignoredToggle = screen.getByRole("button", {
      name: /sourceIgnoredFiles/,
      pressed: false,
    });
    expect(ignoredToggle).toBeDefined();
    const packageGroup = (await screen.findByText("packages/client/")).closest(
      "button",
    );
    expect(packageGroup).not.toBeNull();
    if (!packageGroup) throw new Error("Expected packages/client group");
    fireEvent.click(packageGroup);
    expect(
      document.querySelector(
        '[data-source-path="packages/client/file-000.ts"]',
      ),
    ).not.toBeNull();

    const search = screen.getByPlaceholderText("sourceFilterFiles");
    fireEvent.change(search, { target: { value: "output" } });
    expect(screen.queryByText("build/output.txt")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "sourceIgnoredFiles",
        expanded: false,
      }),
    );
    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(2),
    );
    expect(transport.getSubscriptions("worktree")[1]).toMatchObject({
      projectId: "p1",
      coverage: { tracked: true, untracked: true, ignored: true },
    });
    await emitWorktreeSnapshot(transport, [
      ...currentFiles,
      {
        path: "build/output.txt",
        tracked: false,
        kind: "ignored",
      },
    ]);
    await waitFor(() =>
      expect(
        document.querySelector('[data-source-path="build/output.txt"]'),
      ).not.toBeNull(),
    );
    fireEvent.change(search, { target: { value: "" } });

    fireEvent.click(packageGroup);
    expect(
      document.querySelector(
        '[data-source-path="packages/client/file-000.ts"]',
      ),
    ).toBeNull();
    fireEvent.click(packageGroup);

    fireEvent.click(screen.getByText("README.md"));
    await waitFor(() =>
      expect(
        getFile.mock.calls.some(
          ([projectId, path]) => projectId === "p1" && path === "README.md",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("contents:README.md")).toBeDefined();
    expect(getGitBlame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "sourceViewBlame" }));
    await waitFor(() =>
      expect(getGitBlame).toHaveBeenCalledWith("p1", "README.md"),
    );
  });

  it("freezes visible deltas while paused without releasing the lease", async () => {
    const transport = new FakeSourceTransport();
    const runtime = createRuntime(transport, "test:blame-browser-paused");
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const renderBrowser = (paused: boolean) =>
      withRuntime(
        runtime,
        <ProjectWorktreePauseContext.Provider value={paused}>
          <BlameBrowser
            projectId="p1"
            isWideScreen={false}
            supportsWorkingTreeFiles
            supportsWorktreeSections
            t={t}
          />
        </ProjectWorktreePauseContext.Provider>,
      );
    const view = render(renderBrowser(true));

    await emitWorktreeSnapshot(transport, [
      { path: "README.md", tracked: true, kind: "tracked" },
    ]);
    expect(await screen.findByText("README.md")).toBeDefined();
    const subscription = transport.getSubscriptions("worktree").at(-1);
    if (!subscription) throw new Error("Expected worktree subscription");
    act(() => {
      transport.emitSubscriptionEvent(subscription.id, "git-worktree-delta", {
        type: "git-worktree-delta",
        generation: { epoch: "test-epoch", sequence: 1 },
        headSha: "head-a",
        baseSha: "base-a",
        changes: [
          {
            changeType: "create",
            path: "notes.txt",
            file: {
              path: "notes.txt",
              tracked: false,
              kind: "untracked",
            },
          },
        ],
        timestamp: "2026-08-19T00:00:01.000Z",
      });
    });
    expect(screen.queryByText("notes.txt")).toBeNull();
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);

    view.rerender(renderBrowser(false));
    expect(await screen.findByText("notes.txt")).toBeDefined();
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);
  });

  it("keeps the inventory when the translation function identity changes", async () => {
    const transport = new FakeSourceTransport();
    const runtime = createRuntime(transport, "test:blame-browser-translation");
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const initialT = (key: string) => key;
    const replacementT = (key: string) => key;
    const view = render(
      withRuntime(
        runtime,
        <BlameBrowser
          projectId="p1"
          isWideScreen={false}
          supportsWorkingTreeFiles
          supportsWorktreeSections
          t={initialT}
        />,
      ),
    );

    await emitWorktreeSnapshot(transport, [
      { path: "README.md", tracked: true, kind: "tracked" },
    ]);
    expect(await screen.findByText("README.md")).toBeDefined();
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);
    expect(listGitWorkingTreeFiles).not.toHaveBeenCalled();

    view.rerender(
      withRuntime(
        runtime,
        <BlameBrowser
          projectId="p1"
          isWideScreen={false}
          supportsWorkingTreeFiles
          supportsWorktreeSections
          t={replacementT}
        />,
      ),
    );

    await waitFor(() =>
      expect(transport.getSubscriptions("worktree")).toHaveLength(1),
    );
    expect(screen.getByText("README.md")).toBeDefined();
  });
});
