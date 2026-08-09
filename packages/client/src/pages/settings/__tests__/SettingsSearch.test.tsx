// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SettingsItem } from "../SettingsItem";
import { SettingsSearchBar } from "../SettingsSearchBar";
import {
  SettingsJumpTargetProvider,
  type SettingsSearchScope,
  SettingsSearchScopeProvider,
} from "../SettingsSearchContext";
import { SettingsSearchResults } from "../SettingsSearchResults";
import { SettingsSection } from "../SettingsSection";

vi.mock("../../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

function makeScope(
  overrides: Partial<SettingsSearchScope> = {},
): SettingsSearchScope {
  return {
    query: "",
    matchValues: false,
    sectionMatched: false,
    categoryLabel: "Appearance",
    jumpToItem: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
});

describe("SettingsSearchBar credential boundary", () => {
  it("keeps search outside a mounted settings credential form", () => {
    render(
      <>
        <SettingsSearchBar
          query=""
          onQueryChange={vi.fn()}
          matchValues={false}
          onMatchValuesChange={vi.fn()}
        />
        <input
          type="password"
          aria-label="Browser xAI STT Key"
          autoComplete="new-password"
        />
      </>,
    );

    const search = screen.getByRole("searchbox") as HTMLInputElement;
    const credential = screen.getByLabelText(
      "Browser xAI STT Key",
    ) as HTMLInputElement;

    expect(search.form).not.toBeNull();
    expect(search.form).not.toBe(credential.form);
    expect(search.autocomplete).toBe("off");
    expect(search.name).toBe("settings-search");
  });
});

describe("SettingsItem under search scope", () => {
  it("renders nothing when the query does not match", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "webhook" })}>
        <SettingsItem label="Theme" description="Color scheme">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.queryByLabelText("Theme")).toBeNull();
  });

  it("renders operable with highlighted label on a match", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "theme" })}>
        <SettingsItem label="Theme" description="Color scheme">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Theme")).toBeTruthy();
    const mark = document.querySelector("mark.settings-search-mark");
    expect(mark?.textContent).toBe("Theme");
  });

  it("offers a jump link labeled category › section", () => {
    const jumpToItem = vi.fn();
    render(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "theme", jumpToItem })}
      >
        <SettingsSection title="Display">
          <SettingsItem label="Theme">
            <input aria-label="Theme" />
          </SettingsItem>
        </SettingsSection>
      </SettingsSearchScopeProvider>,
    );
    const origin = screen.getByText("Appearance › Display ›");
    fireEvent.click(origin);
    expect(jumpToItem).toHaveBeenCalledWith("theme");
  });

  it("matches valueText only when matchValues is on", () => {
    const { rerender } = render(
      <SettingsSearchScopeProvider value={makeScope({ query: "dark" })}>
        <SettingsItem label="Theme" valueText="Dark">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.queryByLabelText("Theme")).toBeNull();

    rerender(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "dark", matchValues: true })}
      >
        <SettingsItem label="Theme" valueText="Dark">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Theme")).toBeTruthy();
  });

  it("matches keywords that are never rendered", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "color" })}>
        <SettingsItem label="Theme" keywords={["color scheme"]}>
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Theme")).toBeTruthy();
  });

  it("matches multi-word product names on Session Defaults-style rows", () => {
    render(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "compact context early" })}
      >
        <SettingsItem
          id="session-default-compact-early"
          label="Compact context early"
          description="Optionally ask for compaction once this model's live context passes the chosen share of its full window."
          keywords={["early compact", "autocompact", "/compact"]}
        >
          <input
            type="range"
            aria-label="Compact context early"
            min={0}
            max={99}
          />
        </SettingsItem>
        <SettingsItem label="Unrelated recap">
          <input aria-label="Unrelated recap" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Compact context early")).toBeTruthy();
    expect(screen.queryByLabelText("Unrelated recap")).toBeNull();
  });

  it("omits searchable={false} clones from search even when they would match", () => {
    render(
      <SettingsSearchScopeProvider
        value={makeScope({ query: "compact context early" })}
      >
        <SettingsItem
          id="primary"
          label="Compact context early"
          description="Primary home"
        >
          <input aria-label="Compact context early primary" type="range" />
        </SettingsItem>
        <SettingsItem
          id="clone"
          searchable={false}
          label="Compact context early"
          description="Clone next to Claude"
        >
          <input aria-label="Compact context early clone" type="range" />
        </SettingsItem>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Compact context early primary")).toBeTruthy();
    expect(screen.queryByLabelText("Compact context early clone")).toBeNull();
  });
});

describe("SettingsSection under search scope", () => {
  it("a section title match reveals all child rows", () => {
    render(
      <SettingsSearchScopeProvider value={makeScope({ query: "display" })}>
        <SettingsSection title="Display">
          <SettingsItem label="Theme">
            <input aria-label="Theme" />
          </SettingsItem>
          <SettingsItem label="Tab Size">
            <input aria-label="Tab Size" />
          </SettingsItem>
        </SettingsSection>
      </SettingsSearchScopeProvider>,
    );
    expect(screen.getByLabelText("Theme")).toBeTruthy();
    expect(screen.getByLabelText("Tab Size")).toBeTruthy();
    expect(
      document.querySelector(".settings-search-section-match"),
    ).toBeTruthy();
  });
});

describe("SettingsItem jump target (normal mode)", () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it("scrolls to, flashes, and consumes a matching jump target", () => {
    const consume = vi.fn();
    render(
      <SettingsJumpTargetProvider value={{ target: "theme", consume }}>
        <SettingsItem label="Theme">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsJumpTargetProvider>,
    );
    expect(consume).toHaveBeenCalled();
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled();
    expect(document.querySelector(".settings-item--jump-flash")).toBeTruthy();
  });

  it("ignores a jump target for another row", () => {
    const consume = vi.fn();
    render(
      <SettingsJumpTargetProvider value={{ target: "other", consume }}>
        <SettingsItem label="Theme">
          <input aria-label="Theme" />
        </SettingsItem>
      </SettingsJumpTargetProvider>,
    );
    expect(consume).not.toHaveBeenCalled();
    expect(document.querySelector(".settings-item--jump-flash")).toBeNull();
  });
});

describe("SettingsSearchResults", () => {
  function ToyPane() {
    const [checked, setChecked] = useState(false);
    return (
      <SettingsSection title="General">
        <SettingsItem label="Streaming" description="Live token updates">
          <input
            type="checkbox"
            aria-label="Streaming"
            checked={checked}
            onChange={(event) => setChecked(event.target.checked)}
          />
        </SettingsItem>
      </SettingsSection>
    );
  }

  const categories = [
    { id: "toy", label: "Toy", description: "Toy pane" },
    { id: "other", label: "Other", description: "Second pane" },
  ];
  const components = { toy: ToyPane, other: () => null };

  it("lists matching categories and keeps matched rows operable", () => {
    const onJumpToItem = vi.fn();
    render(
      <SettingsSearchResults
        categories={categories}
        components={components}
        query="streaming"
        matchValues={false}
        onJumpToItem={onJumpToItem}
        onOpenCategory={vi.fn()}
      />,
    );
    const toggle = screen.getByLabelText("Streaming") as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);

    fireEvent.click(screen.getByText("Toy › General ›"));
    expect(onJumpToItem).toHaveBeenCalledWith("toy", "streaming");
  });

  it("shows category matches for category-label queries", () => {
    render(
      <SettingsSearchResults
        categories={categories}
        components={components}
        query="other"
        matchValues={false}
        onJumpToItem={vi.fn()}
        onOpenCategory={vi.fn()}
      />,
    );
    expect(screen.getByText("settingsSearchCategoriesHeading")).toBeTruthy();
    expect(screen.getByText("Second pane")).toBeTruthy();
  });

  it("reports no results when nothing matches", () => {
    render(
      <SettingsSearchResults
        categories={categories}
        components={components}
        query="zzzz"
        matchValues={false}
        onJumpToItem={vi.fn()}
        onOpenCategory={vi.fn()}
      />,
    );
    expect(screen.getByText("settingsSearchNoResults")).toBeTruthy();
  });
});
