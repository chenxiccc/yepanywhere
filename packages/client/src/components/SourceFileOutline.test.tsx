// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
});
