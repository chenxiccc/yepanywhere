// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../i18n";

const previewReview = vi.fn();
const submitReview = vi.fn();
const getGlobalSessions = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    previewReview: (...a: unknown[]) => previewReview(...a),
    submitReview: (...a: unknown[]) => submitReview(...a),
    getGlobalSessions: (...a: unknown[]) => getGlobalSessions(...a),
  },
}));
vi.mock("../lib/reviewCommentsBus", () => ({
  notifyReviewCommentsChanged: vi.fn(),
}));

import { ReviewSubmitModal } from "./ReviewSubmitModal";

const t = (key: string) => key;

function comment(id: string, text: string) {
  return {
    id,
    text,
    status: "pending" as const,
    createdAt: "2026-07-26T00:00:00Z",
    anchor: {
      path: "a.ts",
      revision: {
        kind: "uncommitted" as const,
        savedAt: "2026-07-26T00:00:00Z",
      },
      side: "new" as const,
      oldLine: null,
      newLine: 12,
      snippet: "",
    },
  };
}

const PREVIEW = {
  pendingCount: 2,
  items: [
    {
      comment: comment("gone1", "stale one"),
      relocation: {
        status: "gone" as const,
        path: "a.ts",
        citeSha: "deadbeef00",
        snippet: "",
      },
      defaultDiscard: true,
    },
    {
      comment: comment("live1", "live one"),
      relocation: {
        status: "relocated" as const,
        path: "a.ts",
        line: 12,
        snippet: "",
      },
      defaultDiscard: false,
    },
  ],
};

function renderModal(recentReviewSessionId: string | null) {
  const onClose = vi.fn();
  const onNavigateSession = vi.fn();
  render(
    <I18nProvider>
      <ReviewSubmitModal
        projectId="proj1"
        recentReviewSessionId={recentReviewSessionId}
        onClose={onClose}
        onNavigateSession={onNavigateSession}
        t={t}
      />
    </I18nProvider>,
  );
  return { onClose, onNavigateSession };
}

describe("ReviewSubmitModal", () => {
  beforeEach(() => {
    // Default: no other sessions, so the arbitrary-session picker stays hidden.
    getGlobalSessions.mockResolvedValue({ sessions: [] });
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("lists stale comments first, pre-selected for discard", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    renderModal(null);

    const staleText = await screen.findByText("stale one");
    const staleRow = staleText.closest("li") as HTMLElement;
    const liveRow = screen.getByText("live one").closest("li") as HTMLElement;

    // Stale row comes first in the DOM.
    expect(
      staleRow.compareDocumentPosition(liveRow) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    // Stale is unchecked (discard), live is checked (included).
    expect(
      within(staleRow).getByRole("checkbox").getAttribute("checked"),
    ).toBeNull();
    expect(
      (within(staleRow).getByRole("checkbox") as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (within(liveRow).getByRole("checkbox") as HTMLInputElement).checked,
    ).toBe(true);
  });

  it("defaults the target to the recent review session when present", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    renderModal("sess-recent");

    await screen.findByText("stale one");
    const recent = screen.getByLabelText(
      "sourceReviewTargetRecent",
    ) as HTMLInputElement;
    const fresh = screen.getByLabelText(
      "sourceReviewTargetNew",
    ) as HTMLInputElement;
    expect(recent.checked).toBe(true);
    expect(fresh.checked).toBe(false);
  });

  it("offers only a new session when there is no recent review", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    renderModal(null);

    await screen.findByText("stale one");
    expect(screen.queryByLabelText("sourceReviewTargetRecent")).toBeNull();
    expect(
      (screen.getByLabelText("sourceReviewTargetNew") as HTMLInputElement)
        .checked,
    ).toBe(true);
  });

  it("submits the included comments to the chosen target and navigates", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    submitReview.mockResolvedValue({
      sessionId: "sess-9",
      consumed: ["live1"],
    });
    const { onNavigateSession } = renderModal("sess-recent");

    await screen.findByText("stale one");
    fireEvent.click(screen.getByText("sourceReviewSubmitReview"));

    await waitFor(() =>
      // Only the non-discarded comment, to the recent session.
      expect(submitReview).toHaveBeenCalledWith(
        "proj1",
        ["live1"],
        "sess-recent",
      ),
    );
    expect(onNavigateSession).toHaveBeenCalledWith("sess-9");
  });

  it("submits to an arbitrarily picked session", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    getGlobalSessions.mockResolvedValue({
      sessions: [
        { id: "sess-A", title: "Session A", customTitle: null },
        { id: "sess-B", title: "Session B", customTitle: null },
      ],
    });
    submitReview.mockResolvedValue({
      sessionId: "sess-B",
      consumed: ["live1"],
    });
    const { onNavigateSession } = renderModal(null);

    await screen.findByText("live one");
    const select = (await screen.findByRole("combobox")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "sess-B" } });
    fireEvent.click(screen.getByText("sourceReviewSubmitReview"));

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith("proj1", ["live1"], "sess-B"),
    );
    expect(onNavigateSession).toHaveBeenCalledWith("sess-B");
  });
});
