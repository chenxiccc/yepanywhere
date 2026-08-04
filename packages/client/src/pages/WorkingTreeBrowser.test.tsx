// @vitest-environment jsdom

import type { GitStatusInfo } from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

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

const getGitDiff = vi.fn();
const getGitUntrackedFolder = vi.fn();
const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getGitDiff: (...args: unknown[]) => getGitDiff(...args),
    getGitUntrackedFolder: (...args: unknown[]) =>
      getGitUntrackedFolder(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
  },
}));

import { WorkingTreeBrowser } from "./WorkingTreeBrowser";

const t = (key: string) => key;

describe("WorkingTreeBrowser", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("keeps a clean working tree as the Changes landing", async () => {
    const onBrowseHistory = vi.fn();
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: true,
            files: [],
            recentCommits: [
              {
                hash: "0123456789abcdef",
                shortHash: "0123456",
                subject: "Keep the quick check useful",
                authorName: "Kyle",
                authorDate: "2026-07-28T12:00:00.000Z",
              },
            ],
          }}
          isWideScreen={false}
          onBrowseHistory={onBrowseHistory}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("gitStatusWorkingTreeClean"),
    ).toBeDefined();
    expect(
      screen.getByText("sourceWorkingTreeCleanDescription"),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "sourceCommitHistory" }),
    ).toBeDefined();
    expect(screen.queryByText("gitStatusRecentCommits")).toBeNull();
    expect(screen.queryByText("Keep the quick check useful")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "sourceCommitHistory" }),
    );
    expect(onBrowseHistory).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(listReviewComments).toHaveBeenCalledWith("p1"),
    );
    expect(getGitDiff).not.toHaveBeenCalled();
  });

  it("merges staged and unstaged layers into one reviewable Changes row", async () => {
    getGitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-inserted" data-diff-line="0">+dirty</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+dirty"],
        },
      ],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/dirty.ts",
                status: "M",
                staged: true,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "src/dirty.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 1,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("sourceWorktreePartial")).toBeDefined();
    expect(
      screen
        .getByText("sourceWorktreePartial")
        .getAttribute("data-tooltip"),
    ).toBe("sourceWorktreePartialDescription");
    expect(screen.queryByText("sourceWorktreeUnstaged")).toBeNull();
    expect(screen.queryByText("sourceWorktreeUntracked")).toBeNull();
    expect(
      document.querySelectorAll(".commit-file-item .git-file-path"),
    ).toHaveLength(1);
    const row = document.querySelector(".commit-file-item");
    expect(row?.getAttribute("data-tooltip")).toBe("src/dirty.ts");
    expect(
      row?.querySelector(".git-status-badge")?.getAttribute("data-tooltip"),
    ).toBe("M — sourceFileStatusModified");
    await waitFor(() =>
      expect(getGitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          path: "src/dirty.ts",
          againstHead: true,
        }),
      ),
    );

    // The diff HTML and its delegated comment listener mount asynchronously.
    await waitFor(() =>
      expect(
        document.querySelector('[data-diff-line="0"]'),
      ).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-diff-line="0"]')!);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "please revisit" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));

    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const anchor = addReviewComment.mock.calls[0]?.[1] as {
      revision: { kind: string };
    };
    expect(anchor.revision).toMatchObject({ kind: "uncommitted" });
  });

  it("shows the last-editor session link only behind its capability", async () => {
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const status: GitStatusInfo = {
      isGitRepo: true,
      branch: "main",
      upstream: null,
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        {
          path: "src/dirty.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 1,
          lastEditor: {
            sessionId: "session-1",
            observedAt: "2026-08-02T10:00:00.000Z",
          },
        },
      ],
    };

    const rendered = render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={status}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getGitDiff).toHaveBeenCalled());
    expect(
      screen.queryByRole("link", { name: "sourceOpenLastEditorSession" }),
    ).toBeNull();

    rendered.rerender(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={status}
          isWideScreen={true}
          supportsLastEditor
          t={t}
        />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "sourceOpenLastEditorSession",
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/p1/sessions/session-1",
    );
  });

  it("keeps last-editor links when an untracked folder expands", async () => {
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    getGitUntrackedFolder.mockResolvedValue({
      path: "generated/",
      files: ["generated/a.ts"],
      lastEditors: {
        "generated/a.ts": {
          sessionId: "session-untracked",
          observedAt: "2026-08-02T10:00:00.000Z",
        },
      },
      truncated: false,
      limit: 500,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "generated/",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
          }}
          isWideScreen={true}
          supportsLastEditor
          t={t}
        />
      </MemoryRouter>,
    );

    const link = await screen.findByRole("link", {
      name: "sourceOpenLastEditorSession",
    });
    expect(link.getAttribute("href")).toBe(
      "/projects/p1/sessions/session-untracked",
    );
  });

  it("expands many untracked folders without refetching the open diff", async () => {
    const folders = Array.from({ length: 40 }, (_, i) => `gen${i}/`);
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    // Stagger arrivals across several coalescing windows, the way a real
    // repository's folder expansions land: the browser re-merges its rows once
    // per window while the corpus fills in.
    let arrival = 0;
    getGitUntrackedFolder.mockImplementation(
      (_projectId: string, path: string) =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                path,
                files: [`${path}child.ts`],
                truncated: false,
                limit: 500,
              }),
            (arrival++ % 4) * 60,
          ),
        ),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/tracked.ts",
                status: "M",
                staged: false,
                linesAdded: 3,
                linesDeleted: 1,
              },
              ...folders.map((path) => ({
                path,
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              })),
            ],
            recentCommits: [],
          }}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(getGitUntrackedFolder).toHaveBeenCalledTimes(folders.length),
    );
    await waitFor(() =>
      expect(screen.getByText("gen39/child.ts")).toBeTruthy(),
    );

    // The selected file never changed, so its diff was requested exactly once.
    expect(getGitDiff).toHaveBeenCalledTimes(1);
  });

  it("does not rerender unchanged rows when selection changes", async () => {
    getGitDiff.mockResolvedValue({ diffHtml: "", structuredPatch: [] });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    let translationCalls = 0;
    const countingT = (key: string) => {
      translationCalls += 1;
      return key;
    };
    const files = Array.from({ length: 400 }, (_, index) => ({
      path: `generated/file-${String(index).padStart(3, "0")}.ts`,
      status: "?",
      staged: false,
      linesAdded: null,
      linesDeleted: null,
    }));

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: null,
            ahead: 0,
            behind: 0,
            isClean: false,
            files,
            recentCommits: [],
          }}
          isWideScreen={true}
          t={countingT}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getGitDiff).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(document.querySelector(".git-diff-loading")).toBeNull(),
    );
    const finalRow = (await screen.findByText("generated/file-399.ts")).closest(
      ".commit-file-item",
    );
    if (!finalRow) throw new Error("Final generated file row is missing");
    getGitDiff.mockImplementation(() => new Promise(() => {}));
    translationCalls = 0;

    fireEvent.click(finalRow);

    expect(getGitDiff).toHaveBeenCalledTimes(2);
    expect(translationCalls).toBeLessThan(50);
  });

  it("uses only compact staged and untracked state markers", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/staged.ts",
                status: "M",
                staged: true,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "src/unstaged.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "src/untracked.ts",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    const stagedRow = (await screen.findByText("src/staged.ts")).closest(
      ".commit-file-item",
    );
    if (!stagedRow) throw new Error("Staged file row is missing");
    expect(
      stagedRow.querySelector(".worktree-file-state")?.textContent,
    ).toBe("✓");
    expect(
      stagedRow
        .querySelector(".worktree-file-state")
        ?.getAttribute("data-tooltip"),
    ).toBe("sourceWorktreeStaged");
    expect(
      screen
        .getByText("src/unstaged.ts")
        .closest(".commit-file-item")
        ?.querySelector(".worktree-file-state"),
    ).toBeNull();
    const untrackedRow = screen
      .getByText("src/untracked.ts")
      .closest(".commit-file-item");
    if (!untrackedRow) throw new Error("Untracked file row is missing");
    expect(untrackedRow.querySelector(".worktree-file-state")).toBeNull();
    expect(
      untrackedRow
        .querySelector(".git-status-badge")
        ?.getAttribute("data-tooltip"),
    ).toBe("? — sourceFileStatusUntracked");
  });

  it("filters dirty and expanded untracked files by path", async () => {
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/keep.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "scratch/drop.txt",
                status: "?",
                staged: false,
                linesAdded: null,
                linesDeleted: null,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("src/keep.ts");
    await waitFor(() =>
      expect(listReviewComments).toHaveBeenCalledWith("p1"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "sourceFilterFiles" }),
    );
    const input = screen.getByPlaceholderText("sourceFilterFiles");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "keep" } });

    expect(screen.getByText("src/keep.ts")).toBeDefined();
    expect(screen.queryByText("scratch/drop.txt")).toBeNull();
    fireEvent.change(input, { target: { value: "missing" } });
    expect(screen.getByText("sourceNoMatches")).toBeDefined();
  });

  it("explains an empty ignore-whitespace projection", async () => {
    getGitDiff.mockResolvedValue({
      diffHtml: '<pre class="shiki"><code class="language-ts"></code></pre>',
      structuredPatch: [],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/spaces.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 1,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={true}
          ignoreWhitespace
          t={t}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("gitStatusWhitespaceChangesHidden"),
    ).toBeDefined();
  });

  it("opens a selected phone change in the full-screen diff viewer", async () => {
    getGitDiff.mockResolvedValue({
      diffHtml: "<pre><code>+dirty</code></pre>",
      structuredPatch: [],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/mobile.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    fireEvent.click(await screen.findByText("src/mobile.ts"));

    expect(await screen.findByRole("dialog")).toBeDefined();
    expect(screen.queryByText("sourceWorktreeUnstaged")).toBeNull();
  });

  it("preserves an open comment draft while status refreshes the diff", async () => {
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "test" },
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    getGitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-inserted" data-diff-line="0">+dirty</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+dirty"],
        },
      ],
    });
    const status = (linesAdded: number): GitStatusInfo => ({
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        {
          path: "src/dirty.ts",
          status: "M",
          staged: false,
          linesAdded,
          linesDeleted: 0,
        },
      ],
      recentCommits: [],
    });
    const view = (nextStatus: ReturnType<typeof status>) => (
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={nextStatus}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>
    );
    const { rerender } = render(view(status(1)));

    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-diff-line="0"]')!);
    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "test" },
    });
    getGitDiff.mockClear();
    getGitDiff.mockResolvedValueOnce({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-inserted" data-diff-line="0">+dirty changed</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+dirty changed"],
        },
      ],
    });

    rerender(view(status(2)));

    expect(getGitDiff).toHaveBeenCalledTimes(1);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "test",
    );
    await waitFor(() =>
      expect(
        document.querySelector('[data-diff-line="0"]')?.textContent,
      ).toContain("dirty changed"),
    );

    getGitDiff.mockClear();
    rerender(
      view({
        ...status(0),
        isClean: true,
        files: [],
      }),
    );

    expect(getGitDiff).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "test",
    );
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));
    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const capturedAnchor = addReviewComment.mock.calls[0]?.[1] as {
      snippet: string;
      revision: { kind: string; savedAt?: string };
    };
    expect(capturedAnchor.snippet).toBe("dirty");
    expect(capturedAnchor.revision).toMatchObject({
      kind: "uncommitted",
      savedAt: expect.any(String),
    });
  });

  it.each([
    false,
    true,
  ])("opens the exact Edit-linked dirty file (wide=%s)", async (isWideScreen) => {
    getGitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-inserted" data-diff-line="0">+target</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+target"],
        },
      ],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <WorkingTreeBrowser
          projectId="p1"
          status={{
            isGitRepo: true,
            branch: "main",
            upstream: "origin/main",
            ahead: 0,
            behind: 0,
            isClean: false,
            files: [
              {
                path: "src/other.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
              {
                path: "src/target.ts",
                status: "M",
                staged: false,
                linesAdded: 1,
                linesDeleted: 0,
              },
            ],
            recentCommits: [],
          }}
          isWideScreen={isWideScreen}
          initialWorkingTreePath="src/target.ts"
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(getGitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          path: "src/target.ts",
          againstHead: true,
        }),
      ),
    );
    expect(document.querySelector(".modal") !== null).toBe(!isWideScreen);
  });
});
