// @vitest-environment jsdom

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

const getGitBlame = vi.fn();
const getFile = vi.fn();
const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getFile: (...args: unknown[]) => getFile(...args),
    getGitBlame: (...args: unknown[]) => getGitBlame(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
  },
}));

import { BlameView } from "./BlameView";

const COMMITTED_SHA = "b".repeat(40);
const t = (key: string) => key;

function primeBlame() {
  getFile.mockResolvedValue({
    metadata: {
      path: "src/x.ts",
      size: 25,
      mimeType: "text/typescript",
      isText: true,
    },
    content: "const a = 1;\nconst b = 2;\n",
    rawUrl: "/raw/src/x.ts",
  });
  getGitBlame.mockResolvedValue({
    path: "src/x.ts",
    rev: "HEAD",
    truncated: false,
    highlightedHtml:
      `<pre class="shiki"><code>` +
      `<span class="line">const a = 1;</span>\n` +
      `<span class="line">const b = 2;</span>` +
      `</code></pre>`,
    lines: [
      {
        line: 1,
        sha: COMMITTED_SHA,
        shortSha: "bbbbbbb",
        author: "Dev",
        authorTime: "2026-07-26T00:00:00Z",
        summary: "init",
        content: "const a = 1;",
        uncommitted: false,
      },
      {
        line: 2,
        sha: "0".repeat(40),
        shortSha: "0000000",
        author: "Not Committed Yet",
        authorTime: "",
        summary: "",
        content: "const b = 2;",
        uncommitted: true,
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
}

async function commentOnRow(rowIndex: number, text: string) {
  await waitFor(() =>
    expect(document.querySelectorAll(".blame-row").length).toBe(2),
  );
  fireEvent.click(document.querySelectorAll(".blame-line-target")[rowIndex]!);
  fireEvent.change(await screen.findByRole("textbox"), {
    target: { value: text },
  });
  fireEvent.click(screen.getByText("sourceReviewAddToReview"));
  await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
  return addReviewComment.mock.calls[0]?.[1] as {
    revision: { kind: string; sha?: string };
    side: string;
    oldLine: number | null;
    newLine: number | null;
  };
}

describe("BlameView", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("anchors a committed blame line to its origin sha", async () => {
    primeBlame();
    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    const anchor = await commentOnRow(0, "why const a?");
    expect(anchor.revision).toEqual({ kind: "sha", sha: COMMITTED_SHA });
    expect(anchor.side).toBe("new");
    expect(anchor.oldLine).toBeNull();
    expect(anchor.newLine).toBe(1);
  });

  it("anchors a not-yet-committed blame line as uncommitted", async () => {
    primeBlame();
    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    const anchor = await commentOnRow(1, "wip line");
    expect(anchor.revision.kind).toBe("uncommitted");
    expect(anchor.newLine).toBe(2);
  });

  it("does not tint a line for a pending comment on another revision", async () => {
    primeBlame();
    listReviewComments.mockResolvedValue({
      comments: [
        {
          id: "stale",
          status: "pending",
          text: "from an older commit",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "src/x.ts",
            revision: { kind: "sha", sha: "d".repeat(40) },
            side: "new",
            oldLine: null,
            newLine: 1,
            snippet: "const a = 1;",
          },
        },
      ],
      batches: [],
      pendingCount: 1,
    });

    render(
      <MemoryRouter>
        <BlameView projectId="p1" path="src/x.ts" t={t} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(document.querySelectorAll(".blame-row").length).toBe(2),
    );
    expect(
      document
        .querySelector(".blame-row")
        ?.classList.contains("has-review-comment"),
    ).toBe(false);
  });

  it("shows file content before blame, then enriches hash actions", async () => {
    let resolveBlame!: (value: ReturnType<typeof blameResult>) => void;
    const pendingBlame = new Promise<ReturnType<typeof blameResult>>(
      (resolve) => {
        resolveBlame = resolve;
      },
    );
    getFile.mockResolvedValue({
      metadata: {
        path: "src/x.ts",
        size: 13,
        mimeType: "text/typescript",
        isText: true,
      },
      content: "const fast = 1;\n",
      rawUrl: "/raw/src/x.ts",
    });
    getGitBlame.mockReturnValue(pendingBlame);
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const onOpenCommit = vi.fn();

    render(
      <MemoryRouter>
        <BlameView
          projectId="p1"
          path="src/x.ts"
          onOpenCommit={onOpenCommit}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("const fast = 1;")).toBeTruthy();
    expect(getFile).toHaveBeenCalledWith("p1", "src/x.ts", false);
    expect(document.querySelector(".blame-gutter-loading")).toBeTruthy();
    expect(document.querySelector(".blame-commit-link")).toBeNull();

    await act(async () => {
      resolveBlame(blameResult("const fast = 1;"));
      await pendingBlame;
    });

    const hash = await screen.findByRole("button", { name: "bbbbbbb" });
    expect(hash.getAttribute("title")).toContain("init");
    fireEvent.click(hash);
    expect(onOpenCommit).toHaveBeenCalledWith(COMMITTED_SHA);

    fireEvent.contextMenu(hash, { clientX: 20, clientY: 20 });
    expect(
      await screen.findByRole("menuitem", { name: "sourceCopyCommitHash" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: "sourceOpenCommit" }),
    ).toBeTruthy();
  });
});

function blameResult(content: string) {
  return {
    path: "src/x.ts",
    rev: "HEAD",
    truncated: false,
    lines: [
      {
        line: 1,
        sha: COMMITTED_SHA,
        shortSha: "bbbbbbb",
        author: "Dev",
        authorTime: "2026-07-26T00:00:00Z",
        summary: "init",
        content,
        uncommitted: false,
      },
    ],
  };
}
