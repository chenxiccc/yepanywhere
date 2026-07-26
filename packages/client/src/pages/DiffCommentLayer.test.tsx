// @vitest-environment jsdom

import type { PatchHunk } from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { type RefObject, useRef } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const navigateSpy = vi.fn();
vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => navigateSpy,
}));
vi.mock("../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

const listReviewComments = vi.fn();
const addReviewComment = vi.fn();
const submitReview = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
    addReviewComment: (...args: unknown[]) => addReviewComment(...args),
    submitReview: (...args: unknown[]) => submitReview(...args),
  },
}));

import { DiffCommentLayer } from "./DiffCommentLayer";

// context " a" (old1/new1) · removed "-b" (old2) · added "+c" (new2)
const PATCH: PatchHunk[] = [
  {
    oldStart: 1,
    oldLines: 2,
    newStart: 1,
    newLines: 2,
    lines: [" a", "-b", "+c"],
  },
];

const DIFF_HTML =
  `<pre class="shiki"><code>` +
  `<span class="line line-context" data-diff-line="0"> a</span>\n` +
  `<span class="line line-deleted" data-diff-line="1">-b</span>\n` +
  `<span class="line line-inserted" data-diff-line="2">+c</span>` +
  `</code></pre>`;

const t = (key: string) => key;

function Harness({ patch = PATCH }: { patch?: PatchHunk[] }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div className="diff-modal-content" ref={ref}>
      <div
        className="highlighted-diff"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: test fixture
        dangerouslySetInnerHTML={{ __html: DIFF_HTML }}
      />
      <DiffCommentLayer
        projectId="proj1"
        filePath="src/a.ts"
        structuredPatch={patch}
        containerRef={ref as RefObject<HTMLElement | null>}
        t={t}
      />
    </div>
  );
}

function renderHarness() {
  return render(
    <MemoryRouter>
      <Harness />
    </MemoryRouter>,
  );
}

describe("DiffCommentLayer", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens a comment window anchored to the clicked line", async () => {
    listReviewComments.mockResolvedValue({ comments: [], pendingCount: 0 });
    renderHarness();

    // Click the added line (flat index 2 → new line 2).
    fireEvent.click(document.querySelector('[data-diff-line="2"]')!);

    // Anchor label shows the current (new) line number.
    await screen.findByText("src/a.ts:2");
    expect(screen.getByRole("textbox")).toBeTruthy();
  });

  it("Add to review posts a comment with the derived anchor", async () => {
    listReviewComments.mockResolvedValue({ comments: [], pendingCount: 0 });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    renderHarness();

    fireEvent.click(document.querySelector('[data-diff-line="2"]')!);
    await screen.findByText("src/a.ts:2");

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "why added?" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));

    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const [projectId, anchor, text] = addReviewComment.mock.calls[0] as [
      string,
      Record<string, unknown>,
      string,
    ];
    expect(projectId).toBe("proj1");
    expect(text).toBe("why added?");
    expect(anchor).toMatchObject({
      path: "src/a.ts",
      side: "new",
      oldLine: null,
      newLine: 2,
      revision: { kind: "uncommitted" },
    });
  });

  it("Submit now creates a session and navigates to it", async () => {
    listReviewComments.mockResolvedValue({ comments: [], pendingCount: 0 });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    submitReview.mockResolvedValue({ sessionId: "sess-9", consumed: ["c1"] });
    renderHarness();

    fireEvent.click(document.querySelector('[data-diff-line="1"]')!);
    await screen.findByText("src/a.ts:2"); // removed line: falls back to old line 2

    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "removed why?" },
    });
    fireEvent.click(screen.getByText("sourceReviewSubmitNow"));

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith("proj1", ["c1"], "new"),
    );
    expect(navigateSpy).toHaveBeenCalledWith("/projects/proj1/sessions/sess-9");
  });

  it("anchors a context click to the clicked column's side (side-by-side)", async () => {
    listReviewComments.mockResolvedValue({ comments: [], pendingCount: 0 });
    addReviewComment.mockResolvedValue({
      comment: { id: "c1", status: "pending", anchor: {}, text: "x" },
    });
    // Context line (flat index 0) inside an OLD (left) column.
    function ColHarness() {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <div ref={ref}>
          <div data-diff-col="old">
            <span className="line line-context" data-diff-line="0">
              {" a"}
            </span>
          </div>
          <DiffCommentLayer
            projectId="proj1"
            filePath="src/a.ts"
            structuredPatch={PATCH}
            containerRef={ref as RefObject<HTMLElement | null>}
            t={t}
          />
        </div>
      );
    }
    render(
      <MemoryRouter>
        <ColHarness />
      </MemoryRouter>,
    );

    fireEvent.click(document.querySelector('[data-diff-line="0"]')!);
    await screen.findByRole("textbox");
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "left side" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddToReview"));

    await waitFor(() => expect(addReviewComment).toHaveBeenCalledTimes(1));
    const anchor = addReviewComment.mock.calls[0]?.[1] as {
      side: string;
      oldLine: number | null;
      newLine: number | null;
    };
    // A context line clicked in the left column anchors the old side.
    expect(anchor.side).toBe("old");
    expect(anchor.oldLine).toBe(1);
    expect(anchor.newLine).toBe(1);
  });

  it("tints a line that already has a pending comment", async () => {
    listReviewComments.mockResolvedValue({
      comments: [
        {
          id: "existing",
          status: "pending",
          text: "seen",
          createdAt: "2026-07-26T00:00:00Z",
          anchor: {
            path: "src/a.ts",
            revision: { kind: "uncommitted", savedAt: "2026-07-26T00:00:00Z" },
            side: "new",
            oldLine: null,
            newLine: 2,
            snippet: "c",
          },
        },
      ],
      pendingCount: 1,
    });
    renderHarness();

    await waitFor(() =>
      expect(
        document
          .querySelector('[data-diff-line="2"]')
          ?.classList.contains("has-review-comment"),
      ).toBe(true),
    );
    // A line without a comment is not tinted.
    expect(
      document
        .querySelector('[data-diff-line="0"]')
        ?.classList.contains("has-review-comment"),
    ).toBe(false);
  });
});
