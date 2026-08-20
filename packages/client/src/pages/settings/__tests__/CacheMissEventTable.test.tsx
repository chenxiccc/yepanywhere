// @vitest-environment jsdom

import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n";
import { CacheMissEventTable } from "../CacheMissEventTable";

function record(
  id: string,
  overrides: Partial<CacheMissBillingRecord> = {},
): CacheMissBillingRecord {
  return {
    id,
    timestamp: new Date().toISOString(),
    provider: "claude",
    model: "opus",
    sessionId: `session-${id}`,
    projectId: "project-1" as CacheMissBillingRecord["projectId"],
    sessionPath: `/projects/project-1/sessions/session-${id}`,
    reason: "warm-session-cache-miss",
    outcome: "unexpected-recompute",
    exception: true,
    observedUsage: {
      inputTokens: 100,
      cacheReadTokens: 0,
      totalContextTokens: 100,
      uncachedInputTokens: 100,
    },
    expectedInputCost: {
      state: "expected-new-content",
      source: "warm-session",
      prefixBasis: "same-session-prefix",
      freshEnough: true,
      providerFreshWindowMinutes: 60,
    },
    wastedInputTokens: 100,
    freshWindowMinutes: 60,
    elapsedSinceExpectedCacheMs: 5 * 60_000,
    expectedCacheSource: "warm-session",
    ...overrides,
  };
}

function renderTable(
  events: CacheMissBillingRecord[],
  recencyHours: number | null = null,
) {
  return render(
    <MemoryRouter>
      <I18nProvider>
        <CacheMissEventTable
          events={events}
          basePath=""
          recencyHours={recencyHours}
        />
      </I18nProvider>
    </MemoryRouter>,
  );
}

describe("CacheMissEventTable", () => {
  afterEach(cleanup);

  it("groups rows by provider/model with count, misses, and newest age", () => {
    renderTable([
      record("miss"),
      record("hit", {
        outcome: "expected-cache-hit",
        reason: "warm-session-cache-hit",
      }),
    ]);

    expect(screen.getByText("claude / opus")).toBeTruthy();
    expect(screen.getByText(/2 events · 1 misses/)).toBeTruthy();
    expect(screen.getByText("newest now")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(2);
  });

  it("collapses a provider/model outline group", () => {
    renderTable([record("miss"), record("other")]);

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse claude / opus" }),
    );

    expect(screen.queryAllByRole("link", { name: "Open" })).toHaveLength(0);
    expect(
      screen.getByRole("button", { name: "Expand claude / opus" }),
    ).toBeTruthy();
  });

  it("filters only on the provider/model tuple column", () => {
    renderTable([
      record("claude"),
      record("codex", { provider: "codex", model: "gpt-5.6" }),
    ]);

    fireEvent.change(screen.getByRole("searchbox"), {
      target: { value: "gpt-5.6" },
    });

    expect(screen.queryByText("claude / opus")).toBeNull();
    expect(screen.getByText("codex / gpt-5.6")).toBeTruthy();
    expect(screen.getByText("1 of 2 rows")).toBeTruthy();
  });

  it("shows a finite recency window in the filtered row count", () => {
    renderTable([record("recent")], 1);

    expect(screen.getByText("1 of 1 rows (last 1h)")).toBeTruthy();
  });

  it("uses a compact message reference and exposes the full id on hover", () => {
    renderTable([
      record("message", {
        messageId: "provider-message-identifier",
        messageIndex: 211,
      }),
    ]);

    expect(screen.getByText("Msg")).toBeTruthy();
    const reference = screen.getByText("#211");
    expect(reference.title).toBe("provider-message-identifier");
  });
});
