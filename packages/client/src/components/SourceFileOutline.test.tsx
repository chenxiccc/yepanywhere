// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SourceFileOutline, type SourceOutlineItem } from "./SourceFileOutline";

const t = (key: string) => key;

type TestFile = { path: string };

function item(
  path: string,
  statuses: string[] = [],
): SourceOutlineItem<TestFile> {
  return {
    id: path,
    path,
    displayPath: path,
    statuses,
    value: { path },
  };
}

function TestOutline({
  items,
  scopeKey = "test",
}: {
  items: SourceOutlineItem<TestFile>[];
  scopeKey?: string;
}) {
  return (
    <SourceFileOutline
      items={items}
      scopeKey={scopeKey}
      renderFile={(entry, visiblePath, pathProps) => (
        <li key={entry.id}>
          <span {...pathProps} data-source-path={entry.displayPath}>
            {visiblePath}
          </span>
        </li>
      )}
      t={t}
    />
  );
}

describe("SourceFileOutline", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("preserves an explicit disclosure choice when the corpus refreshes", async () => {
    const rendered = render(
      <TestOutline items={[item("src/a.ts"), item("src/b.ts")]} />,
    );

    const collapse = await screen.findByRole("button", {
      name: "sourceCollapsePathGroup",
    });
    expect(
      document.querySelector('[data-source-path="src/a.ts"]'),
    ).not.toBeNull();
    fireEvent.click(collapse);
    expect(document.querySelector('[data-source-path="src/a.ts"]')).toBeNull();

    rendered.rerender(
      <TestOutline
        items={[item("src/a.ts"), item("src/b.ts"), item("src/c.ts")]}
      />,
    );

    expect(
      screen.getByRole("button", { name: "sourceExpandPathGroup" }),
    ).toBeDefined();
    expect(document.querySelector('[data-source-path="src/c.ts"]')).toBeNull();
  });

  it("summarizes every status represented by a collapsed group", async () => {
    render(
      <TestOutline
        items={[item("src/added.ts", ["A"]), item("src/modified.ts", ["M"])]}
      />,
    );

    const collapse = await screen.findByRole("button", {
      name: "sourceCollapsePathGroup",
    });
    fireEvent.click(collapse);
    const group = screen.getByRole("button", {
      name: "sourceExpandPathGroup",
    });
    expect(group.textContent).toContain("A");
    expect(group.textContent).toContain("M");
  });

  it("groups one-child directory paths without measuring width", async () => {
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");

    render(<TestOutline items={[item("a/only-child.ts")]} />);

    expect(
      await screen.findByRole("button", {
        name: "sourceCollapsePathGroup",
      }),
    ).toBeDefined();
    expect(screen.getByText("only-child.ts")).toBeDefined();
    expect(
      document.querySelector('[data-source-path="a/only-child.ts"]'),
    ).not.toBeNull();
    expect(measure).not.toHaveBeenCalled();
  });

  it("keeps one-child grouping when the corpus refreshes", async () => {
    const rendered = render(<TestOutline items={[item("short.ts")]} />);

    rendered.rerender(
      <TestOutline items={[item("a/parent/refreshed-child.ts")]} />,
    );

    expect(
      await screen.findByRole("button", {
        name: "sourceCollapsePathGroup",
      }),
    ).toBeDefined();
    expect(screen.getByText("refreshed-child.ts")).toBeDefined();
  });

  it("counts only direct files in explicit directory rows", () => {
    render(
      <SourceFileOutline
        items={[item("src/a.ts"), item("src/nested/b.ts")]}
        directories={[
          { path: "src", pending: false, truncated: false },
          { path: "src/nested", pending: false, truncated: false },
        ]}
        expandedDirectories={new Set(["src", "src/nested"])}
        onToggleDirectory={vi.fn()}
        scopeKey="explicit-directories"
        renderFile={(entry, visiblePath, pathProps) => (
          <li key={entry.id}>
            <span {...pathProps}>{visiblePath}</span>
          </li>
        )}
        t={t}
      />,
    );

    const src = screen
      .getAllByRole("button", { name: "sourceCollapseDirectory" })
      .find((button) => button.textContent?.includes("src/"));
    expect(src?.querySelector("[class*='groupCount']")?.textContent).toBe("1");
  });

  it("toggles every path group while keeping the active file visible", async () => {
    render(
      <SourceFileOutline
        items={[item("src/a.ts"), item("docs/b.ts")]}
        scopeKey="toggle-all"
        activeItemId="src/a.ts"
        toggleAllOnEnter
        renderFile={(entry, visiblePath, pathProps) => (
          <li key={entry.id}>
            <button type="button" data-source-list-item>
              <span {...pathProps}>{visiblePath}</span>
            </button>
          </li>
        )}
        t={t}
      />,
    );

    const activePath = await screen.findByText("a.ts");
    const activeRow = activePath.closest("button")!;
    activeRow.focus();
    expect(fireEvent.keyDown(activeRow, { key: "Enter" })).toBe(false);

    expect(
      document.querySelector('[data-source-outline-id="src/a.ts"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-source-outline-id="docs/b.ts"]'),
    ).toBeNull();
    expect(document.activeElement).toBe(activeRow);

    fireEvent.keyDown(activeRow, { key: "Enter" });
    await waitFor(() =>
      expect(
        document.querySelector('[data-source-outline-id="docs/b.ts"]'),
      ).not.toBeNull(),
    );
  });

  it("expands and focuses a requested file hidden by a collapsed parent", async () => {
    const rendered = render(
      <SourceFileOutline
        items={[item("src/a.ts"), item("src/b.ts")]}
        scopeKey="focus-request"
        activeItemId="src/a.ts"
        focusRequest={0}
        renderFile={(entry, visiblePath, pathProps) => (
          <li key={entry.id}>
            <button type="button" data-source-list-item>
              <span {...pathProps}>{visiblePath}</span>
            </button>
          </li>
        )}
        t={t}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "sourceCollapsePathGroup" }),
    );
    expect(
      document.querySelector('[data-source-outline-id="src/a.ts"]'),
    ).toBeNull();

    rendered.rerender(
      <SourceFileOutline
        items={[item("src/a.ts"), item("src/b.ts")]}
        scopeKey="focus-request"
        activeItemId="src/a.ts"
        focusRequest={1}
        renderFile={(entry, visiblePath, pathProps) => (
          <li key={entry.id}>
            <button type="button" data-source-list-item>
              <span {...pathProps}>{visiblePath}</span>
            </button>
          </li>
        )}
        t={t}
      />,
    );

    await waitFor(() =>
      expect(
        document.activeElement?.querySelector(
          '[data-source-outline-id="src/a.ts"]',
        ),
      ).not.toBeNull(),
    );
  });
});
