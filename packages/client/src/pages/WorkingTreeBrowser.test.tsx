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
            recentCommits: [],
          }}
          isWideScreen={false}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(
      await screen.findByText("gitStatusWorkingTreeClean"),
    ).toBeDefined();
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

    expect(await screen.findByText("sourceWorktreeBoth")).toBeDefined();
    expect(
      document.querySelectorAll(".commit-file-item .git-file-path"),
    ).toHaveLength(1);
    await waitFor(() =>
      expect(getGitDiff).toHaveBeenCalledWith(
        "p1",
        expect.objectContaining({
          path: "src/dirty.ts",
          againstHead: true,
        }),
      ),
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
    expect(screen.getByText("sourceWorktreeUnstaged")).toBeDefined();
  });
});
