// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReviewComment } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

const deleteReviewComment = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    deleteReviewComment: (...args: unknown[]) => deleteReviewComment(...args),
  },
}));

import { ReviewCommentsPanel } from "./ReviewCommentsPanel";

const t = (key: string) => key;

function comment(
  id: string,
  overrides: Partial<ReviewComment["anchor"]> = {},
): ReviewComment {
  return {
    id,
    anchor: {
      path: "src/a.ts",
      revision: { kind: "sha", sha: "a".repeat(40) },
      side: "new",
      oldLine: null,
      newLine: 12,
      snippet: "const a = 1;",
      snippetAnchorOffset: 0,
      ...overrides,
    },
    text: `comment ${id}`,
    status: "pending",
    createdAt: "2026-07-26T00:00:00Z",
  };
}

describe("ReviewCommentsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists pending comments with anchor locations and text", () => {
    render(
      <ReviewCommentsPanel
        projectId="p1"
        pending={[
          comment("c1"),
          comment("c2", { path: "src/b.ts", side: "old", oldLine: 4 }),
        ]}
        onOpenFile={vi.fn()}
        onSubmit={vi.fn()}
        t={t}
      />,
    );

    expect(screen.getByText("src/a.ts:12")).toBeTruthy();
    expect(screen.getByText("src/b.ts:4 (old)")).toBeTruthy();
    expect(screen.getByText("comment c1")).toBeTruthy();
  });

  it("opens the file's blame from the location link", () => {
    const onOpenFile = vi.fn();
    render(
      <ReviewCommentsPanel
        projectId="p1"
        pending={[comment("c1")]}
        onOpenFile={onOpenFile}
        onSubmit={vi.fn()}
        t={t}
      />,
    );

    fireEvent.click(screen.getByText("src/a.ts:12"));
    expect(onOpenFile).toHaveBeenCalledWith("src/a.ts");
  });

  it("deletes only after a confirming second click", async () => {
    deleteReviewComment.mockResolvedValue({ ok: true });
    render(
      <ReviewCommentsPanel
        projectId="p1"
        pending={[comment("c1")]}
        onOpenFile={vi.fn()}
        onSubmit={vi.fn()}
        t={t}
      />,
    );

    fireEvent.click(screen.getByText("sourceReviewDelete"));
    expect(deleteReviewComment).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("sourceReviewDeleteConfirm"));
    await screen.findByText("sourceReviewDelete");
    expect(deleteReviewComment).toHaveBeenCalledWith("p1", "c1");
  });

  it("shows the empty state with the how-to hint", () => {
    render(
      <ReviewCommentsPanel
        projectId="p1"
        pending={[]}
        onOpenFile={vi.fn()}
        onSubmit={vi.fn()}
        t={t}
      />,
    );

    expect(screen.getByText("sourceReviewNoPending")).toBeTruthy();
    expect(screen.getByText("sourceReviewCommentsHint")).toBeTruthy();
  });
});
