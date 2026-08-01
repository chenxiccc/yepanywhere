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
const getProviders = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    previewReview: (...a: unknown[]) => previewReview(...a),
    submitReview: (...a: unknown[]) => submitReview(...a),
    getGlobalSessions: (...a: unknown[]) => getGlobalSessions(...a),
    getProviders: (...a: unknown[]) => getProviders(...a),
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

function renderModal(
  recentReviewSessionId: string | null,
  submissionsEnabled = false,
) {
  const onClose = vi.fn();
  const onNavigateSession = vi.fn();
  render(
    <I18nProvider>
      <ReviewSubmitModal
        projectId="proj1"
        recentReviewSessionId={recentReviewSessionId}
        submissionsEnabled={submissionsEnabled}
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
    getGlobalSessions.mockResolvedValue({ sessions: [] });
    getProviders.mockResolvedValue({
      providers: [
        {
          name: "claude",
          displayName: "Claude",
          installed: true,
          authenticated: true,
          enabled: true,
          models: [
            { id: "sonnet", name: "Sonnet" },
            { id: "opus", name: "Opus" },
          ],
        },
      ],
    });
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
    const target = screen.getByLabelText(
      "sourceReviewTargetLegend",
    ) as HTMLSelectElement;
    expect(target.value).toBe("sess-recent");
  });

  it("offers a new session with explicit provider and model controls", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    renderModal(null);

    await screen.findByText("stale one");
    expect(
      (screen.getByLabelText("sourceReviewTargetLegend") as HTMLSelectElement)
        .value,
    ).toBe("new");
    expect(
      (await screen.findByLabelText(
        "sourceReviewProvider",
      )) as HTMLSelectElement,
    ).toBeTruthy();
    expect(
      screen.getByLabelText("sourceReviewModel") as HTMLSelectElement,
    ).toBeTruthy();
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
        undefined,
      ),
    );
    expect(onNavigateSession).toHaveBeenCalledWith("sess-9");
  });

  it("submits to an arbitrarily picked session", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    getGlobalSessions.mockResolvedValue({
      sessions: [
        {
          id: "sess-A",
          title: "Session A",
          customTitle: null,
          provider: "claude",
          model: "sonnet",
        },
        {
          id: "sess-B",
          title: "Session B",
          customTitle: null,
          provider: "codex",
          model: "gpt-5",
        },
      ],
    });
    submitReview.mockResolvedValue({
      sessionId: "sess-B",
      consumed: ["live1"],
    });
    const { onNavigateSession } = renderModal(null);

    await screen.findByText("live one");
    const select = screen.getByLabelText(
      "sourceReviewTargetLegend",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "sess-B" } });
    fireEvent.click(screen.getByText("sourceReviewSubmitReview"));

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith(
        "proj1",
        ["live1"],
        "sess-B",
        undefined,
      ),
    );
    expect(onNavigateSession).toHaveBeenCalledWith("sess-B");
  });

  it("submits the selected provider and model for a new review session", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    submitReview.mockResolvedValue({
      sessionId: "sess-new",
      consumed: ["live1"],
    });
    renderModal(null);

    await screen.findByText("live one");
    fireEvent.change(await screen.findByLabelText("sourceReviewModel"), {
      target: { value: "opus" },
    });
    fireEvent.click(screen.getByText("sourceReviewSubmitReview"));

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith("proj1", ["live1"], "new", {
        provider: "claude",
        model: "opus",
      }),
    );
  });

  it("sends one stable submission id and the optional name", async () => {
    previewReview.mockResolvedValue(PREVIEW);
    submitReview.mockResolvedValue({ status: "queued" });
    renderModal(null, true);

    await screen.findByText("live one");
    const name = screen.getByLabelText(
      "sourceReviewSubmissionName",
    ) as HTMLInputElement;
    expect(name.placeholder).toBe("live one");
    fireEvent.change(name, { target: { value: "Parser follow-up" } });
    fireEvent.click(screen.getByText("sourceReviewSubmitReview"));

    await waitFor(() =>
      expect(submitReview).toHaveBeenCalledWith(
        "proj1",
        ["live1"],
        "new",
        { provider: "claude", model: undefined },
        { id: expect.any(String), name: "Parser follow-up" },
      ),
    );
    expect(
      await screen.findByText("sourceReviewSubmissionQueued"),
    ).toBeTruthy();
  });
});
