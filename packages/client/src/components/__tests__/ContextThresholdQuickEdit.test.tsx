// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ContextThresholdQuickEdit } from "../ContextThresholdQuickEdit";

const refresh = vi.fn();
const updateSetting = vi.fn(async () => undefined);

vi.mock("../../hooks/useProviderSubscriptionUsage", () => ({
  useProviderSubscriptionUsage: () => ({
    usage: {
      provider: "claude",
      fetchedAt: "2026-07-29T00:00:00.000Z",
      windows: [
        {
          id: "weekly",
          usedPercent: 72,
          windowDurationMinutes: 10_080,
          scope: { type: "provider" },
        },
        {
          id: "fable",
          usedPercent: 100,
          windowDurationMinutes: 10_080,
          scope: { type: "models", modelIds: ["fable"], label: "Fable" },
        },
      ],
    },
    loading: false,
    supported: true,
    refresh,
  }),
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: { clientDefaults: { compactAtContextPercent: {} } },
    updateSetting,
  }),
}));

vi.mock("../../hooks/useProviders", () => ({
  useProviders: () => ({
    providers: [
      { name: "claude", supportsNativeCompactThreshold: false },
      { name: "codex", supportsNativeCompactThreshold: true },
    ],
  }),
}));

describe("ContextThresholdQuickEdit", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens applicable subscription windows on left click", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 50_000,
            contextWindow: 1_000_000,
            percentage: 5,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", {
        name: /Subscription usage 100% used/,
      }),
    );

    expect(
      screen.getByRole("dialog", { name: "Subscription usage" }),
    ).toBeTruthy();
    expect(screen.getAllByText("100%").length).toBeGreaterThan(0);
    expect(screen.getByText("Fable · 7d window")).toBeTruthy();
  });

  it("shows provider-reported cache accounting for the last turn", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 104_966,
            contextWindow: 1_000_000,
            percentage: 10,
            outputTokens: 333,
            cacheReadTokens: 103_341,
            cacheCreationTokens: 1_623,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: /Context 10%/ }));

    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Read from cache");
    expect(dialog.textContent).toContain("103,341");
    expect(dialog.textContent).toContain("Written to cache");
    expect(dialog.textContent).toContain("1,623");
    expect(dialog.textContent).toContain("104,966");
  });

  it("omits the token section when no cache or output counts are reported", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 50_000,
            contextWindow: 1_000_000,
            percentage: 5,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: /Subscription usage 100% used/ }),
    );

    expect(screen.getByRole("dialog").textContent).not.toContain(
      "Read from cache",
    );
  });

  it("preserves right-click access to compact threshold editing", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 50_000,
            contextWindow: 1_000_000,
            percentage: 5,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(
      screen.getByRole("button", {
        name: /Subscription usage 100% used/,
      }),
    );

    expect(screen.getByRole("dialog").textContent).toContain(
      "Compact context early",
    );
  });

  it("keeps subscription dialog controls keyboard-operable", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="claude"
          model="fable"
          usage={{
            inputTokens: 50_000,
            contextWindow: 1_000_000,
            percentage: 5,
          }}
        />
      </I18nProvider>,
    );
    const trigger = screen.getByRole("button", {
      name: /Subscription usage 100% used/,
    });
    fireEvent.keyDown(trigger, { key: "Enter" });

    const refreshButton = screen.getByRole("button", {
      name: "Refresh subscription usage",
    });
    fireEvent.keyDown(refreshButton, { key: "Enter" });
    expect(
      screen.getByRole("dialog", { name: "Subscription usage" }),
    ).toBeTruthy();
    fireEvent.click(refreshButton);
    expect(refresh).toHaveBeenCalledOnce();

    const editButton = screen.getByRole("button", {
      name: "Edit compact threshold",
    });
    fireEvent.keyDown(editButton, { key: " " });
    expect(
      screen.getByRole("dialog", { name: "Subscription usage" }),
    ).toBeTruthy();
    fireEvent.click(editButton);
    expect(screen.getByRole("dialog").textContent).toContain(
      "Compact context early",
    );
  });

  it("offers the global YA-orchestrated override for native providers", () => {
    render(
      <I18nProvider>
        <ContextThresholdQuickEdit
          provider="codex"
          model="gpt-5.6"
          usage={{
            inputTokens: 50_000,
            contextWindow: 272_000,
            percentage: 18,
          }}
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("button"));
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Have YA trigger /compact" }),
    );

    expect(updateSetting).toHaveBeenCalledWith("clientDefaults", {
      forceYaOrchestratedCompaction: true,
    });
  });
});
