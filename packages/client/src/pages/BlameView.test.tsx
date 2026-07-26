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

const getGitBlame = vi.fn();
const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getGitBlame: (...args: unknown[]) => getGitBlame(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
  },
}));

import { BlameView } from "./BlameView";

const COMMITTED_SHA = "b".repeat(40);
const t = (key: string) => key;

function primeBlame() {
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
  listReviewComments.mockResolvedValue({ comments: [], pendingCount: 0 });
  addReviewComment.mockResolvedValue({
    comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
  });
}

async function commentOnRow(rowIndex: number, text: string) {
  await waitFor(() =>
    expect(document.querySelectorAll(".blame-row").length).toBe(2),
  );
  fireEvent.click(document.querySelectorAll(".blame-row")[rowIndex]!);
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
});
