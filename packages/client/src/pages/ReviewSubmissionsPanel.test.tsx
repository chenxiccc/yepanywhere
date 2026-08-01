// @vitest-environment jsdom

import type { ReviewBatch, ReviewComment } from "@yep-anywhere/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { TranslationFn } from "../i18n";
import { ReviewSubmissionsPanel } from "./ReviewSubmissionsPanel";

const t: TranslationFn = (key, vars) =>
  vars?.date ? `${key}:${vars.date}` : key;

function archivedComment(
  id: string,
  text: string,
  batchId: string,
): ReviewComment {
  return {
    id,
    text,
    status: "archived",
    createdAt: "2026-07-30T09:00:00.000Z",
    archivedAt: "2026-07-30T10:00:00.000Z",
    batchId,
    targetSessionId: `session-${batchId}`,
    anchor: {
      path: `${id}.ts`,
      revision: { kind: "sha", sha: "a".repeat(40) },
      side: "new",
      oldLine: 4,
      newLine: 5,
      snippet: `const ${id} = true;`,
    },
  };
}

const BATCHES: ReviewBatch[] = [
  {
    id: "older",
    submittedAt: "2026-07-30T10:00:00.000Z",
    targetSessionId: "session-older",
    commentIds: ["old-comment"],
  },
  {
    id: "newer",
    submittedAt: "2026-07-31T10:00:00.000Z",
    targetSessionId: "session-newer",
    commentIds: ["new-comment"],
  },
];

describe("ReviewSubmissionsPanel", () => {
  afterEach(cleanup);

  it("opens the newest batch with its archived comments and session link", () => {
    render(
      <MemoryRouter>
        <ReviewSubmissionsPanel
          batches={BATCHES}
          archived={[
            archivedComment("old-comment", "old feedback", "older"),
            archivedComment("new-comment", "new feedback", "newer"),
          ]}
          sessionHref={(sessionId) => `/sessions/${sessionId}`}
          t={t}
        />
      </MemoryRouter>,
    );

    expect(screen.getByText("new feedback")).toBeTruthy();
    expect(screen.getByText("new-comment.ts:5")).toBeTruthy();
    expect(screen.getByText("sourceReviewLegacyCaptureMissing")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "sourceReviewOpenSession" })
        .getAttribute("href"),
    ).toBe("/sessions/session-newer");
  });

  it("uses one selection for the list and phone selector", () => {
    render(
      <MemoryRouter>
        <ReviewSubmissionsPanel
          batches={BATCHES}
          archived={[
            archivedComment("old-comment", "old feedback", "older"),
            archivedComment("new-comment", "new feedback", "newer"),
          ]}
          sessionHref={(sessionId) => `/sessions/${sessionId}`}
          t={t}
        />
      </MemoryRouter>,
    );

    const selector = screen.getByLabelText(
      "sourceReviewSelectSubmission",
    ) as HTMLSelectElement;
    fireEvent.change(selector, { target: { value: "older" } });

    expect(screen.getByText("old feedback")).toBeTruthy();
    expect(selector.value).toBe("older");
    expect(
      screen
        .getByRole("link", { name: "sourceReviewOpenSession" })
        .getAttribute("href"),
    ).toBe("/sessions/session-older");
  });
});
