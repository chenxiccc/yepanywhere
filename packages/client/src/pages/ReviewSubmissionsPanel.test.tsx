// @vitest-environment jsdom

import type {
  ReviewSubmissionDetail,
  ReviewSubmissionSummary,
} from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const listReviewSubmissions = vi.fn();
const getReviewSubmission = vi.fn();
const acknowledgeReviewSubmission = vi.fn();
const addReviewFollowUp = vi.fn();
const resolveReviewSite = vi.fn();
const refreshReviewSubmissionResponse = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    listReviewSubmissions: (...args: unknown[]) =>
      listReviewSubmissions(...args),
    getReviewSubmission: (...args: unknown[]) => getReviewSubmission(...args),
    acknowledgeReviewSubmission: (...args: unknown[]) =>
      acknowledgeReviewSubmission(...args),
    addReviewFollowUp: (...args: unknown[]) => addReviewFollowUp(...args),
    resolveReviewSite: (...args: unknown[]) => resolveReviewSite(...args),
    refreshReviewSubmissionResponse: (...args: unknown[]) =>
      refreshReviewSubmissionResponse(...args),
  },
}));

import type { TranslationFn } from "../i18n";
import { ReviewSubmissionsPanel } from "./ReviewSubmissionsPanel";

const t: TranslationFn = (key, vars) =>
  vars?.date ? `${key}:${vars.date}` : key;

function summary(
  id: string,
  submittedAt: string,
  name?: string,
): ReviewSubmissionSummary {
  return {
    id,
    name,
    submittedAt,
    requestedTarget: `session-${id}`,
    targetSessionId: `session-${id}`,
    entryRefs: [{ siteId: `site-${id}`, entryId: `entry-${id}` }],
    status: "accepted",
    deliveryStatus: "delivered",
    responseRevision: 0,
    acknowledgedRevision: 0,
  };
}

const NEWER = summary("newer", "2026-07-31T10:00:00.000Z", "Parser cleanup");
const OLDER = summary("older", "2026-07-30T10:00:00.000Z");

function detail(
  submission: ReviewSubmissionSummary,
  captured: boolean,
): ReviewSubmissionDetail {
  const siteId = `site-${submission.id}`;
  const entryId = `entry-${submission.id}`;
  return {
    submission,
    sites: [
      {
        id: siteId,
        path: `src/${submission.id}.ts`,
        createdAt: submission.submittedAt,
        entries: [
          {
            id: entryId,
            text: `${submission.id} feedback`,
            anchor: {
              path: `src/${submission.id}.ts`,
              revision: { kind: "sha", sha: "a".repeat(40) },
              side: "new",
              oldLine: 4,
              newLine: 5,
              snippet: "const reviewed = true;",
            },
            capture: captured
              ? {
                  status: "captured",
                  captureBlobId: "b".repeat(40),
                  projection: {
                    kind: "revision",
                    revision: "a".repeat(40),
                    path: `src/${submission.id}.ts`,
                    side: "new",
                  },
                }
              : { status: "legacy-missing" },
            createdAt: submission.submittedAt,
            submittedAt: submission.submittedAt,
            submissionId: submission.id,
          },
        ],
        outcomes: [],
      },
    ],
    capturedSources: [
      {
        siteId,
        entryId,
        changeStatus: captured ? "unchanged" : "unavailable",
        source: captured
          ? {
              status: "captured",
              captureBlobId: "b".repeat(40),
              content: "before\nconst reviewed = true;\nafter",
              startLine: 4,
              highlightLine: 5,
            }
          : { status: "legacy-missing" },
      },
    ],
  };
}

function renderPanel() {
  listReviewSubmissions.mockResolvedValue({
    submissions: [NEWER, OLDER],
    nextCursor: null,
  });
  getReviewSubmission.mockImplementation(
    async (_projectId: string, id: string) =>
      id === "newer" ? detail(NEWER, true) : detail(OLDER, false),
  );
  render(
    <MemoryRouter>
      <ReviewSubmissionsPanel
        projectId="proj1"
        sessionHref={(sessionId) => `/sessions/${sessionId}`}
        t={t}
      />
    </MemoryRouter>,
  );
}

describe("ReviewSubmissionsPanel", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the newest submission against its captured source", async () => {
    renderPanel();

    expect(await screen.findByText("newer feedback")).toBeTruthy();
    expect(screen.getAllByText("src/newer.ts")).toHaveLength(1);
    expect(screen.getByTitle("src/newer.ts:5").textContent).toBe("5");
    expect(screen.getByText("const reviewed = true;")).toBeTruthy();
    expect(screen.getByText(/sourceReviewCapturedSource/)).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "sourceReviewOpenSession" })
        .getAttribute("href"),
    ).toBe("/sessions/session-newer");
    expect(screen.getByText("sourceReviewStateOpen")).toBeTruthy();
    expect(screen.getByText("sourceReviewSourceUnchanged")).toBeTruthy();
  });

  it("keeps older migrated reviews explicit about missing captures", async () => {
    renderPanel();
    await screen.findByText("newer feedback");
    fireEvent.change(screen.getByLabelText("sourceReviewSelectSubmission"), {
      target: { value: "older" },
    });

    expect(await screen.findAllByText("older feedback")).toHaveLength(2);
    expect(screen.getByText("sourceReviewLegacyCaptureMissing")).toBeTruthy();
  });

  it("opens the submission selected by an Inbox deep link", async () => {
    listReviewSubmissions.mockResolvedValue({
      submissions: [NEWER],
      nextCursor: null,
    });
    getReviewSubmission.mockImplementation(
      async (_projectId: string, id: string) =>
        id === "newer" ? detail(NEWER, true) : detail(OLDER, false),
    );
    render(
      <MemoryRouter>
        <ReviewSubmissionsPanel
          projectId="proj1"
          initialSubmissionId="older"
          sessionHref={(sessionId) => `/sessions/${sessionId}`}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findAllByText("older feedback")).toHaveLength(2);
  });

  it("adds a fresh follow-up to Pending Comments and resolves explicitly", async () => {
    addReviewFollowUp.mockResolvedValue({ entry: {} });
    resolveReviewSite.mockResolvedValue({ resolved: true });
    renderPanel();
    await screen.findByText("newer feedback");

    fireEvent.change(screen.getByLabelText("sourceReviewFollowUp"), {
      target: { value: "Please check the fallback too" },
    });
    fireEvent.click(screen.getByText("sourceReviewAddFollowUp"));
    await waitFor(() =>
      expect(addReviewFollowUp).toHaveBeenCalledWith(
        "proj1",
        "site-newer",
        "Please check the fallback too",
      ),
    );

    fireEvent.click(screen.getByText("sourceReviewResolve"));
    await waitFor(() =>
      expect(resolveReviewSite).toHaveBeenCalledWith("proj1", "site-newer"),
    );
  });

  it("keeps addressed state independent from unchanged source", async () => {
    listReviewSubmissions.mockResolvedValue({
      submissions: [NEWER],
      nextCursor: null,
    });
    const addressed = detail(NEWER, true);
    addressed.sites[0]!.outcomes.push({
      submissionId: NEWER.id,
      entryId: "entry-newer",
      disposition: "wont_fix",
      text: "The compatibility contract requires this shape.",
      observedAt: "2026-08-01T00:00:00Z",
      responseHash: "c".repeat(64),
      sessionId: "session-newer",
    });
    getReviewSubmission.mockResolvedValue(addressed);
    render(
      <MemoryRouter>
        <ReviewSubmissionsPanel
          projectId="proj1"
          sessionHref={(sessionId) => `/sessions/${sessionId}`}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("sourceReviewStateAddressed")).toBeTruthy();
    expect(screen.getByText("sourceReviewSourceUnchanged")).toBeTruthy();
    expect(screen.getByText("sourceReviewOutcomeNoChange")).toBeTruthy();
    expect(
      screen.getByText("The compatibility contract requires this shape."),
    ).toBeTruthy();
  });

  it("refreshes response files explicitly after the automatic window", async () => {
    refreshReviewSubmissionResponse.mockResolvedValue({
      ...detail(NEWER, true),
      responseStatus: "unchanged",
    });
    renderPanel();
    await screen.findByText("newer feedback");
    fireEvent.click(screen.getByText("sourceReviewRefreshResponse"));

    await waitFor(() =>
      expect(refreshReviewSubmissionResponse).toHaveBeenCalledWith(
        "proj1",
        "newer",
      ),
    );
    expect(
      await screen.findByText("sourceReviewResponseUnchanged"),
    ).toBeTruthy();
  });

  it("acknowledges an unread revision only after its detail renders", async () => {
    const unread = {
      ...NEWER,
      responseRevision: 1,
      acknowledgedRevision: 0,
    };
    listReviewSubmissions.mockResolvedValue({
      submissions: [unread],
      nextCursor: null,
    });
    getReviewSubmission.mockResolvedValue(detail(unread, true));
    acknowledgeReviewSubmission.mockResolvedValue({
      submission: { ...unread, acknowledgedRevision: 1 },
    });
    render(
      <MemoryRouter>
        <ReviewSubmissionsPanel
          projectId="proj1"
          sessionHref={(sessionId) => `/sessions/${sessionId}`}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(await screen.findByText("newer feedback")).toBeTruthy();
    await waitFor(() =>
      expect(acknowledgeReviewSubmission).toHaveBeenCalledWith(
        "proj1",
        "newer",
      ),
    );
  });
});
