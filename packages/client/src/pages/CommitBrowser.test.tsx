// @vitest-environment jsdom

import type { GitStatusInfo } from "@yep-anywhere/shared";
import {
  act,
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

const getGitCommits = vi.fn();
const getGitCommit = vi.fn();
const getGitCommitDiff = vi.fn();
const getGitComparison = vi.fn();
const getGitComparisonDiff = vi.fn();
const getGitDiff = vi.fn();
const getGitUntrackedFolder = vi.fn();
const getGitCommitSearchManifest = vi.fn();
const getGitCommitSearchRecords = vi.fn();
const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getGitCommits: (...args: unknown[]) => getGitCommits(...args),
    getGitCommit: (...args: unknown[]) => getGitCommit(...args),
    getGitCommitDiff: (...args: unknown[]) => getGitCommitDiff(...args),
    getGitComparison: (...args: unknown[]) => getGitComparison(...args),
    getGitComparisonDiff: (...args: unknown[]) => getGitComparisonDiff(...args),
    getGitDiff: (...args: unknown[]) => getGitDiff(...args),
    getGitUntrackedFolder: (...args: unknown[]) =>
      getGitUntrackedFolder(...args),
    getGitCommitSearchManifest: (...args: unknown[]) =>
      getGitCommitSearchManifest(...args),
    getGitCommitSearchRecords: (...args: unknown[]) =>
      getGitCommitSearchRecords(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
  },
}));

import { CommitBrowser } from "./CommitBrowser";

const SHA = "a".repeat(40);
const HEAD_SHA = "b".repeat(40);
const DIRECT_SHA = "c".repeat(40);
const t = (key: string) => key;

function dirtyStatus(): GitStatusInfo {
  return {
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
        linesAdded: 1,
        linesDeleted: 0,
      },
    ],
    recentCommits: [],
  };
}

function cleanStatus(): GitStatusInfo {
  return {
    ...dirtyStatus(),
    isClean: true,
    files: [],
  };
}

function installScrollIntoViewMock() {
  const original = Element.prototype.scrollIntoView;
  const mock = vi.fn();
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: mock,
  });
  return {
    fn: mock,
    restore() {
      if (original) {
        Object.defineProperty(Element.prototype, "scrollIntoView", {
          configurable: true,
          value: original,
        });
      } else {
        delete (Element.prototype as { scrollIntoView?: unknown })
          .scrollIntoView;
      }
    },
  };
}

function primeApis() {
  const firstCommit = {
    hash: SHA,
    shortHash: "aaaaaaa",
    subject: "first commit",
    authorName: "Dev",
    authorDate: "2026-07-26T00:00:00Z",
  };
  getGitCommits.mockResolvedValue({
    commits: [firstCommit],
    hasMore: false,
  });
  getGitCommit.mockResolvedValue({
    hash: SHA,
    shortHash: "aaaaaaa",
    subject: "first commit",
    authorName: "Dev",
    authorDate: "2026-07-26T00:00:00Z",
    body: "",
    files: [
      {
        path: "src/x.ts",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    ],
  });
  getGitCommitDiff.mockResolvedValue({
    diffHtml:
      `<pre class="shiki"><code>` +
      `<span class="line line-inserted" data-diff-line="0">+hi</span>` +
      `</code></pre>`,
    structuredPatch: [
      { oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: ["+hi"] },
    ],
  });
  getGitComparison.mockResolvedValue({
    baseSha: SHA,
    headSha: HEAD_SHA,
    files: [
      {
        path: "src/cumulative.ts",
        status: "M",
        staged: false,
        linesAdded: 2,
        linesDeleted: 1,
      },
    ],
  });
  getGitComparisonDiff.mockResolvedValue({
    diffHtml:
      `<pre class="shiki"><code>` +
      `<span class="line line-inserted" data-diff-line="0">+cumulative</span>` +
      `</code></pre>`,
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ["+cumulative"],
      },
    ],
  });
  listReviewComments.mockResolvedValue({
    comments: [],
    batches: [],
    pendingCount: 0,
  });
}

describe("CommitBrowser", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists commits, opens a commit's files, and fetches the file diff", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("first commit");
    // Wide screen auto-selects the newest commit → its files load.
    await screen.findByText("src/x.ts");
    // …and auto-selects the first file → the commit diff is fetched.
    await waitFor(() =>
      expect(getGitCommitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ sha: SHA, path: "src/x.ts", status: "M" }),
      ),
    );
  });

  it("opens a directly linked file within the selected commit", async () => {
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "",
      files: [
        {
          path: "src/first.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
        {
          path: "src/linked.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    });

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          initialSha={SHA}
          initialPath="src/linked.ts"
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("src/linked.ts");
    await waitFor(() =>
      expect(
        document.querySelector(".commit-file-item.selected")?.textContent,
      ).toContain("src/linked.ts"),
    );
    await waitFor(() =>
      expect(getGitCommitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ path: "src/linked.ts" }),
      ),
    );
  });

  it("keeps a direct blame-hash revision selected beyond the recent page", async () => {
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: DIRECT_SHA,
      shortHash: "ccccccc",
      subject: "older blamed commit",
      authorName: "Older Dev",
      authorDate: "2025-01-01T00:00:00Z",
      body: "",
      files: [],
    });

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          initialSha={DIRECT_SHA}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findAllByText("older blamed commit")).toHaveLength(2);
    expect(getGitCommit).toHaveBeenCalledWith("p1", DIRECT_SHA);
    expect(
      document.querySelector(".commit-list-item.selected")?.textContent,
    ).toContain("ccccccc");
  });

  it("toggles a direct selected-revision-to-HEAD comparison", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          supportsProjections
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("src/x.ts");
    fireEvent.click(
      screen.getByRole("button", { name: "sourceCompareToHead" }),
    );

    expect(await screen.findByText("src/cumulative.ts")).toBeDefined();
    expect(getGitComparison).toHaveBeenCalledWith("p1", SHA);
    await waitFor(() =>
      expect(getGitComparisonDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          baseSha: SHA,
          headSha: HEAD_SHA,
          path: "src/cumulative.ts",
          status: "M",
        }),
      ),
    );
    expect(
      screen
        .getByRole("button", { name: "sourceCompareToHead" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("makes no comparison request when the server lacks the projection", async () => {
    primeApis();
    const onProjectionUnavailable = vi.fn();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          onProjectionUnavailable={onProjectionUnavailable}
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("src/x.ts");
    fireEvent.click(
      screen.getByRole("button", { name: "sourceCompareToHead" }),
    );

    expect(onProjectionUnavailable).toHaveBeenCalled();
    expect(getGitComparison).not.toHaveBeenCalled();
    expect(getGitComparisonDiff).not.toHaveBeenCalled();
  });

  it("returns to the ordinary commit diff when a projection request fails", async () => {
    primeApis();
    getGitComparison.mockRejectedValueOnce(new Error("server is stale"));
    const onProjectionUnavailable = vi.fn();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          supportsProjections
          onProjectionUnavailable={onProjectionUnavailable}
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("src/x.ts");
    fireEvent.click(
      screen.getByRole("button", { name: "sourceCompareToHead" }),
    );

    await waitFor(() => expect(onProjectionUnavailable).toHaveBeenCalled());
    expect(screen.getAllByText("src/x.ts").length).toBeGreaterThan(0);
    expect(
      screen
        .getByRole("button", { name: "sourceCompareToHead" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("requests the whitespace projection for the active commit diff", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          ignoreWhitespace
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("src/x.ts");
    await waitFor(() =>
      expect(getGitCommitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          sha: SHA,
          path: "src/x.ts",
          ignoreWhitespace: true,
        }),
      ),
    );
  });

  it("filters the selected commit's files from an expandable search", async () => {
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "",
      files: [
        {
          path: "test/drop.test.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
        {
          origPath: "legacy/original.ts",
          path: "src/keep.ts",
          status: "R",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    });

    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("test/drop.test.ts");
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "sourceFilterFiles" }));
    fireEvent.change(screen.getByPlaceholderText("sourceFilterFiles"), {
      target: { value: "legacy" },
    });

    expect(screen.getByText("legacy/original.ts → src/keep.ts")).toBeDefined();
    expect(screen.queryByText("test/drop.test.ts")).toBeNull();
    await waitFor(() =>
      expect(getGitCommitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({ path: "src/keep.ts" }),
      ),
    );
  });

  it("pins the shared Working tree browser above commit history", async () => {
    primeApis();
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

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={dirtyStatus()}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    await waitFor(() =>
      expect(getGitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          path: "src/dirty.ts",
          againstHead: true,
        }),
      ),
    );
    expect(getGitCommit).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByText("first commit"));
    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
  });

  it("opens the newest commit for a clean tree and keeps Working tree selectable", async () => {
    primeApis();

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={cleanStatus()}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
    const workingTreeRow = document.querySelector(
      ".commit-list-working-tree .commit-list-item",
    ) as HTMLButtonElement;
    const commitRow = document.querySelector(
      ".commit-list-row:not(.commit-list-working-tree) .commit-list-item",
    ) as HTMLButtonElement;
    expect(workingTreeRow.classList.contains("selected")).toBe(false);
    expect(commitRow.classList.contains("selected")).toBe(true);
    expect(await screen.findByText("gitStatusWorkingTreeClean")).toBeDefined();

    fireEvent.click(workingTreeRow);
    expect(workingTreeRow.classList.contains("selected")).toBe(true);
    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(screen.getByText("first commit")).toBeDefined();
  });

  it("opens the newest commit for a clean tree on phone", async () => {
    primeApis();

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={cleanStatus()}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
    expect(await screen.findByText("gitStatusWorkingTreeClean")).toBeDefined();
    expect(document.querySelector(".commit-revisions-column")).toBeNull();
  });

  it("falls back to Working tree when a clean repository has no commits", async () => {
    primeApis();
    getGitCommits.mockResolvedValue({ commits: [], hasMore: false });

    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          status={cleanStatus()}
          isWideScreen={true}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByTestId("working-tree-browser")).toBeDefined();
    expect(getGitCommit).not.toHaveBeenCalled();
  });

  it("uses arrow keys to move the focused revision selection", async () => {
    const older = "b".repeat(40);
    primeApis();
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "first commit",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
        {
          hash: older,
          shortHash: "bbbbbbb",
          subject: "older commit",
          authorName: "Dev",
          authorDate: "2026-07-25T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    getGitCommit.mockImplementation((_projectId: string, sha: string) =>
      Promise.resolve({
        hash: sha,
        shortHash: sha.slice(0, 7),
        subject: sha === SHA ? "first commit" : "older commit",
        authorName: "Dev",
        authorDate: "2026-07-26T00:00:00Z",
        body: "",
        files: [],
      }),
    );

    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const first = (await screen.findByText("first commit")).closest("button");
    const second = screen.getByText("older commit").closest("button");
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    act(() => {
      first?.focus();
    });
    getGitCommit.mockClear();
    act(() => {
      fireEvent.keyDown(first!, { key: "ArrowDown" });
    });

    expect(document.activeElement).toBe(second);
    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", older));
  });

  it("opens revision actions by context key or right-click", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const row = (await screen.findByText("first commit")).closest("button")!;
    const shortcutHelp = screen.getByRole("button", {
      name: "sourceShortcutHelp",
    });
    fireEvent.click(shortcutHelp);
    expect((await screen.findByRole("tooltip")).textContent).toContain(
      "sourceShortcutSearch",
    );
    fireEvent.click(shortcutHelp);
    expect(screen.queryByRole("tooltip")).toBeNull();

    fireEvent.contextMenu(row, { clientX: 40, clientY: 50 });
    expect(await screen.findByRole("menu")).toBeDefined();
    expect(screen.getByText("sourceCopyCommitSubject")).toBeDefined();

    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(document.activeElement).toBe(row);

    fireEvent.keyDown(row, { key: "F10", shiftKey: true });
    expect(await screen.findByRole("menu")).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "sourceMarkReadToHere" }),
    ).toBeDefined();
  });

  it("resizes the revision pane from either edge handle by keyboard", async () => {
    primeApis();
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );
    await screen.findByText("first commit");
    await screen.findByText("src/x.ts");

    const handles = screen.getAllByRole("separator", {
      name: "sourceResizeRevisionPane",
    });
    expect(handles).toHaveLength(2);
    expect(handles[0]?.getAttribute("aria-valuenow")).toBe("300");
    act(() => {
      fireEvent.keyDown(handles[0]!, { key: "ArrowRight" });
    });
    await waitFor(() => {
      expect(handles[0]?.getAttribute("aria-valuenow")).toBe("316");
      expect(handles[1]?.getAttribute("aria-valuenow")).toBe("316");
    });
  });

  it("focuses commit search with slash", async () => {
    primeApis();
    const focusHead = "f".repeat(40);
    getGitCommitSearchManifest.mockResolvedValue({
      head: focusHead,
      commits: [],
    });
    getGitCommitSearchRecords.mockResolvedValue({ records: [] });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    const search = await screen.findByPlaceholderText("sourceSearchCommits");
    act(() => {
      fireEvent.keyDown(window, { key: "/" });
    });
    expect(document.activeElement).toBe(search);
    await waitFor(() =>
      expect(getGitCommitSearchManifest).toHaveBeenCalledWith("p1"),
    );
    await waitFor(() =>
      expect(document.querySelector(".source-search-index-status")).toBeNull(),
    );
  });

  it("anchors a commit-diff comment to the commit sha", async () => {
    primeApis();
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    // Wait for the diff to render, then click the inserted line.
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    fireEvent.click(document.querySelector('[data-diff-line="0"]')!);

    fireEvent.change(await screen.findByRole("textbox"), {
      target: { value: "why this line?" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));

    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const anchor = addReviewComment.mock.calls[0]?.[1] as {
      revision: { kind: string; sha?: string };
      side: string;
      newLine: number | null;
    };
    expect(anchor.revision).toEqual({ kind: "sha", sha: SHA });
    expect(anchor.side).toBe("new");
    expect(anchor.newLine).toBe(1);
  });

  it("drills from any mobile commit into files and back to the list", async () => {
    const middleSha = "b".repeat(40);
    const oldestSha = "c".repeat(40);
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "newest commit",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
        {
          hash: middleSha,
          shortHash: "bbbbbbb",
          subject: "middle commit",
          authorName: "Dev",
          authorDate: "2026-07-25T00:00:00Z",
        },
        {
          hash: oldestSha,
          shortHash: "ccccccc",
          subject: "oldest commit",
          authorName: "Dev",
          authorDate: "2026-07-24T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    getGitCommit.mockImplementation((_projectId: string, sha: string) =>
      Promise.resolve({
        hash: sha,
        shortHash: sha.slice(0, 7),
        subject: "selected commit",
        authorName: "Dev",
        authorDate: "2026-07-25T00:00:00Z",
        body: "",
        files: [
          {
            path: "src/middle.ts",
            status: "M",
            staged: false,
            linesAdded: 2,
            linesDeleted: 1,
          },
        ],
      }),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const historyBack = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});

    try {
      render(
        <MemoryRouter>
          <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
        </MemoryRouter>,
      );

      fireEvent.click(await screen.findByText("middle commit"));

      expect(await screen.findByText("src/middle.ts")).toBeDefined();
      expect(screen.queryByText("newest commit")).toBeNull();
      expect(screen.queryByText("oldest commit")).toBeNull();
      expect(
        screen.getByRole("button", { name: "sourceCommitHistory" }),
      ).toBeDefined();

      fireEvent.click(
        screen.getByRole("button", { name: "sourceCommitHistory" }),
      );
      expect(historyBack).toHaveBeenCalled();
      act(() => {
        window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
      });

      expect(await screen.findByText("middle commit")).toBeDefined();
      expect(screen.queryByText("src/middle.ts")).toBeNull();
    } finally {
      historyBack.mockRestore();
      window.history.replaceState(null, "");
    }
  });

  it("searches the complete client index beyond the loaded commit page", async () => {
    primeApis();
    const OTHER = "c".repeat(40);
    const indexedCommits = [
      {
        hash: SHA,
        shortHash: "aaaaaaa",
        subject: "first commit",
        authorName: "Dev",
        authorDate: "2026-07-26T00:00:00Z",
      },
      ...Array.from({ length: 60 }, (_, index) => ({
        hash: `${(index + 1).toString(16).padStart(40, "0")}`,
        shortHash: (index + 1).toString(16).padStart(7, "0"),
        subject: `older ${index}`,
        authorName: "Dev",
        authorDate: "2026-07-20T00:00:00Z",
      })),
      {
        hash: OTHER,
        shortHash: "ccccccc",
        subject: "touched needle",
        authorName: "Dev",
        authorDate: "2026-07-19T00:00:00Z",
      },
    ];
    getGitCommitSearchManifest.mockResolvedValue({
      head: SHA,
      commits: indexedCommits,
    });
    getGitCommitSearchRecords.mockImplementation(
      (_projectId: string, shas: string[]) => ({
        records: shas.map((hash) => ({
          hash,
          deltaText: hash === OTHER ? "src/deep.ts\nneedle" : "",
        })),
      }),
    );
    getGitCommits.mockResolvedValue({
      commits: indexedCommits.slice(0, 50),
      hasMore: true,
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("first commit");
    fireEvent.change(screen.getByPlaceholderText("sourceSearchCommits"), {
      target: { value: "needle" },
    });

    await screen.findByText("touched needle");
    expect(screen.queryByText("first commit")).toBeNull();
    expect(getGitCommitSearchManifest).toHaveBeenCalledWith("p1");
    expect(getGitCommitSearchRecords).toHaveBeenCalled();
    expect(screen.queryByText("sourceLoadMore")).toBeNull();
  });

  it("searches commit metadata before delta batches finish", async () => {
    primeApis();
    const OTHER = "c".repeat(40);
    getGitCommitSearchManifest.mockResolvedValue({
      head: OTHER,
      commits: [
        {
          hash: OTHER,
          shortHash: "ccccccc",
          subject: "touched needle",
          authorName: "Dev",
          authorDate: "2026-07-20T00:00:00Z",
        },
      ],
    });
    getGitCommitSearchRecords.mockResolvedValue({
      records: [{ hash: OTHER, deltaText: "" }],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("first commit");
    fireEvent.change(screen.getByPlaceholderText("sourceSearchCommits"), {
      target: { value: "needle" },
    });

    await screen.findByText("touched needle");
  });

  it("jumps to the older commit via the commit-jump selector", async () => {
    const OLDER = "d".repeat(40);
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "newest",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
        {
          hash: OLDER,
          shortHash: "ddddddd",
          subject: "older one",
          authorName: "Dev",
          authorDate: "2026-07-20T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "newest",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: "",
      files: [],
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    // Wide screen auto-selects the newest → detail loads for it.
    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", SHA));
    getGitCommit.mockClear();

    // Newer/older jump is now a glyph button; the phrase is its title.
    fireEvent.click(await screen.findByTitle("sourceOlderCommit"));
    await waitFor(() => expect(getGitCommit).toHaveBeenCalledWith("p1", OLDER));
  });

  it("badges a commit with its pending review-comment count", async () => {
    getGitCommits.mockResolvedValue({
      commits: [
        {
          hash: SHA,
          shortHash: "aaaaaaa",
          subject: "first commit",
          authorName: "Dev",
          authorDate: "2026-07-26T00:00:00Z",
        },
      ],
      hasMore: false,
    });
    listReviewComments.mockResolvedValue({
      comments: [
        {
          id: "c1",
          status: "pending",
          text: "why?",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "src/x.ts",
            revision: { kind: "sha", sha: SHA },
            side: "new",
            oldLine: null,
            newLine: 1,
            snippet: "",
          },
        },
      ],
      batches: [],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText("first commit");
    const badges = await screen.findAllByTitle("sourceCommentCount");
    expect(badges.some((badge) => badge.textContent === "1")).toBe(true);
  });

  it("repeats the subject, soft-reflows the body, and opens the verbatim message", async () => {
    const first =
      "Rendered commit prose is commonly hard-wrapped for a readable terminal";
    const second =
      "but those stored breaks become jagged in the narrow source review pane.";
    primeApis();
    getGitCommit.mockResolvedValue({
      hash: SHA,
      shortHash: "aaaaaaa",
      subject: "first commit",
      authorName: "Dev",
      authorDate: "2026-07-26T00:00:00Z",
      body: `${first}\n${second}`,
      files: [
        {
          path: "src/x.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    });
    render(
      <MemoryRouter>
        <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    const compactBody = await screen.findByTitle("sourceShowFullMessage");
    expect(compactBody.textContent).toBe(`first commit\n\n${first} ${second}`);
    fireEvent.click(compactBody);
    await waitFor(() =>
      expect(document.querySelector(".commit-message-full")).not.toBeNull(),
    );
    expect(document.querySelector(".commit-message-full")?.textContent).toBe(
      `first commit\n\n${first}\n${second}`,
    );
  });

  it("bridges a commit file to its blame view via onBlameFile", async () => {
    primeApis();
    const onBlameFile = vi.fn();
    render(
      <MemoryRouter>
        <CommitBrowser
          projectId="p1"
          isWideScreen={true}
          onBlameFile={onBlameFile}
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("src/x.ts");
    // The blame action now lives in the selected-file banner (diff header),
    // which renders once the file auto-selects.
    await waitFor(() =>
      expect(document.querySelector('[data-diff-line="0"]')).not.toBeNull(),
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "sourceBlameAtHead" }),
    );
    expect(onBlameFile).toHaveBeenCalledWith("src/x.ts");
  });

  it("re-clicks the selected file to advance to the next diff hunk", async () => {
    primeApis();
    getGitCommitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-hunk">@@ -1 +1 @@</span>` +
        `<span class="line line-inserted" data-diff-line="0">+first</span>` +
        `<span class="line line-hunk">@@ -10 +10 @@</span>` +
        `<span class="line line-inserted" data-diff-line="1">+second</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+first"],
        },
        {
          oldStart: 10,
          oldLines: 0,
          newStart: 10,
          newLines: 1,
          lines: ["+second"],
        },
      ],
    });
    const scrollIntoView = installScrollIntoViewMock();

    try {
      render(
        <MemoryRouter>
          <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
        </MemoryRouter>,
      );

      await waitFor(() =>
        expect(document.querySelectorAll(".line-hunk")).toHaveLength(2),
      );
      fireEvent.click(document.querySelector(".commit-file-item")!);

      expect(scrollIntoView.fn).toHaveBeenCalledWith({
        block: "start",
        behavior: "smooth",
      });
      expect(scrollIntoView.fn.mock.instances[0]).toBe(
        document.querySelectorAll(".line-hunk")[1],
      );
    } finally {
      scrollIntoView.restore();
    }
  });

  it("uses n/p for symmetric hunk navigation except while typing", async () => {
    primeApis();
    getGitCommitDiff.mockResolvedValue({
      diffHtml:
        `<pre class="shiki"><code>` +
        `<span class="line line-hunk">@@ -1 +1 @@</span>` +
        `<span class="line line-inserted" data-diff-line="0">+first</span>` +
        `<span class="line line-hunk">@@ -10 +10 @@</span>` +
        `<span class="line line-inserted" data-diff-line="1">+second</span>` +
        `</code></pre>`,
      structuredPatch: [
        {
          oldStart: 1,
          oldLines: 0,
          newStart: 1,
          newLines: 1,
          lines: ["+first"],
        },
        {
          oldStart: 10,
          oldLines: 0,
          newStart: 10,
          newLines: 1,
          lines: ["+second"],
        },
      ],
    });
    const scrollIntoView = installScrollIntoViewMock();

    try {
      render(
        <MemoryRouter>
          <CommitBrowser projectId="p1" isWideScreen={true} t={t} />
        </MemoryRouter>,
      );

      await waitFor(() =>
        expect(document.querySelectorAll(".line-hunk")).toHaveLength(2),
      );
      const search = screen.getByPlaceholderText("sourceSearchCommits");
      fireEvent.keyDown(search, { key: "n" });
      expect(scrollIntoView.fn).not.toHaveBeenCalled();

      fireEvent.keyDown(window, { key: "n" });
      expect(scrollIntoView.fn).toHaveBeenCalledTimes(1);
      expect(scrollIntoView.fn.mock.instances[0]).toBe(
        document.querySelectorAll(".line-hunk")[1],
      );

      fireEvent.keyDown(window, { key: "p" });
      expect(scrollIntoView.fn).toHaveBeenCalledTimes(2);
      expect(scrollIntoView.fn.mock.instances[1]).toBe(
        document.querySelectorAll(".line-hunk")[0],
      );
    } finally {
      scrollIntoView.restore();
    }
  });
});
