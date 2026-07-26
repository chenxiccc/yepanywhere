// @vitest-environment jsdom

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

const getGitCommits = vi.fn();
const getGitCommit = vi.fn();
const getGitCommitDiff = vi.fn();
const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getGitCommits: (...args: unknown[]) => getGitCommits(...args),
    getGitCommit: (...args: unknown[]) => getGitCommit(...args),
    getGitCommitDiff: (...args: unknown[]) => getGitCommitDiff(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
  },
}));

import { CommitBrowser } from "./CommitBrowser";

const SHA = "a".repeat(40);
const t = (key: string) => key;

function primeApis() {
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
  listReviewComments.mockResolvedValue({ comments: [], pendingCount: 0 });
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
});
