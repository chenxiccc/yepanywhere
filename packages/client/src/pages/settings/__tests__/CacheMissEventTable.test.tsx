// @vitest-environment jsdom

import type { CacheMissBillingRecord } from "@yep-anywhere/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCacheMissEventOutcomeFilterPreference } from "../../../hooks/useCacheMissEventOutcomeFilter";
import { I18nProvider } from "../../../i18n";
import { UI_KEYS } from "../../../lib/storageKeys";
import { CacheMissEventTable } from "../CacheMissEventTable";

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;

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
  afterEach(() => {
    cleanup();
    resetCacheMissEventOutcomeFilterPreference();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
  });

  it("groups rows by provider/model with count, misses, and newest age", () => {
    renderTable([
      record("miss"),
      record("hit", {
        outcome: "expected-cache-hit",
        reason: "warm-session-cache-hit",
      }),
    ]);
    fireEvent.change(screen.getByRole("combobox", { name: "Result" }), {
      target: { value: "all" },
    });

    expect(screen.getByText("claude / opus")).toBeTruthy();
    expect(screen.getByText(/2 events · 1 misses/)).toBeTruthy();
    expect(screen.getByText("newest now")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "Open" })).toHaveLength(2);
  });

  it("counts expected expiry as a miss and labels it as expected", () => {
    renderTable([
      record("expiry", {
        reason: "warm-session-cache-expiry",
        outcome: "expected-cache-expiry",
        exception: false,
        expectedInputCost: {
          state: "expected-new-content",
          source: "warm-session",
          prefixBasis: "same-session-prefix",
          freshEnough: false,
          providerFreshWindowMinutes: 60,
        },
      }),
    ]);

    expect(screen.getByText(/1 events · 1 misses/)).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Expected miss" })).toBeTruthy();
  });

  it("shows the event's exact timestamp instead of a relative age", () => {
    const timestamp = "2026-08-23T12:34:56.000Z";
    const { container } = renderTable([record("timed", { timestamp })]);

    const time = container.querySelector(
      `tr[tabindex="-1"] time[datetime="${timestamp}"]`,
    );
    expect(time).toBeTruthy();
    expect(time?.textContent).toMatch(/\d/);
    expect(time?.textContent).toContain(":");
    expect(time?.textContent).not.toContain("now");
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
    expect(reference.title).toContain("provider-message-identifier");
  });

  it("persists the result filter across revisits and defaults to misses", () => {
    const events = [
      record("miss"),
      record("hit", {
        outcome: "expected-cache-hit",
        reason: "warm-session-cache-hit",
      }),
    ];
    const first = renderTable(events);

    const resultFilter = screen.getByRole<HTMLSelectElement>("combobox", {
      name: "Result",
    });
    expect(resultFilter.value).toBe("misses");
    expect(screen.getByRole("cell", { name: "Miss" })).toBeTruthy();
    expect(screen.queryByRole("cell", { name: "Hit" })).toBeNull();

    fireEvent.change(resultFilter, { target: { value: "hits" } });
    expect(screen.getByRole("cell", { name: "Hit" })).toBeTruthy();
    expect(localStorage.getItem(UI_KEYS.cacheMissEventOutcomeFilter)).toBe(
      "hits",
    );

    first.unmount();
    renderTable(events);
    expect(
      screen.getByRole<HTMLSelectElement>("combobox", { name: "Result" }).value,
    ).toBe("hits");
  });

  it("color-codes sessions and jumps to their previous visible turn", () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });

    renderTable([
      record("newest", {
        sessionId: "session-shared",
        messageIndex: 211,
        timestamp: "2026-08-23T12:00:00.000Z",
      }),
      record("previous", {
        sessionId: "session-shared",
        messageIndex: 198,
        timestamp: "2026-08-23T11:00:00.000Z",
      }),
      record("other", {
        sessionId: "session-other",
        messageIndex: 77,
        timestamp: "2026-08-23T10:00:00.000Z",
      }),
    ]);

    const newestRow = screen.getByText("#211").closest("tr");
    const previousRow = screen.getByText("#198").closest("tr");
    const otherRow = screen.getByText("#77").closest("tr");
    expect(newestRow?.style.getPropertyValue("--cache-session-color")).toBe(
      previousRow?.style.getPropertyValue("--cache-session-color"),
    );
    expect(newestRow?.style.getPropertyValue("--cache-session-color")).not.toBe(
      otherRow?.style.getPropertyValue("--cache-session-color"),
    );

    fireEvent.click(screen.getByText("#211"));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    expect(document.activeElement).toBe(previousRow);
  });
});
