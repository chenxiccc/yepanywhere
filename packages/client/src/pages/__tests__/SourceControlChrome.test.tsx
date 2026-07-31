// @vitest-environment jsdom

import type { GitStatusInfo } from "@yep-anywhere/shared";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SourceRowMenuTrigger,
  sourceRowMenuSurface,
} from "../../components/SourceContextMenu";
import menuStyles from "../../components/SourceContextMenu.module.css";
import { RepoStatusBar } from "../RepoStatusBar";
import repoStyles from "../RepoStatusBar.module.css";
import { SourceModeTabs, type SourceTab } from "../SourceModeTabs";
import tabStyles from "../SourceModeTabs.module.css";

const t = ((key: string) => key) as never;

const TABS: readonly SourceTab[] = ["changes", "files", "comments"];

function gitStatus(overrides: Partial<GitStatusInfo> = {}): GitStatusInfo {
  return {
    isGitRepo: true,
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    isClean: true,
    files: [],
    ...overrides,
  };
}

afterEach(cleanup);

describe("RepoStatusBar", () => {
  it("takes caller placement through className without exposing its own classes", () => {
    render(
      <RepoStatusBar
        status={gitStatus()}
        className="source-header-repo-status"
        t={t}
      />,
    );

    const bar = screen.getByTestId("repo-status-bar");
    expect(bar.classList.contains("source-header-repo-status")).toBe(true);
    expect(bar.classList.contains(repoStyles.bar as string)).toBe(true);
    expect(bar.classList.contains(repoStyles.inline as string)).toBe(true);
    // The legacy global vocabulary is gone; callers cannot target it any more.
    expect(document.querySelector(".repo-status-bar")).toBeNull();
  });

  it("marks a dirty or out-of-sync repository with the warn variant", () => {
    const { rerender } = render(<RepoStatusBar status={gitStatus()} t={t} />);
    expect(
      screen.getByTestId("repo-status-bar").classList.contains(
        repoStyles.warn as string,
      ),
    ).toBe(false);

    rerender(<RepoStatusBar status={gitStatus({ ahead: 2 })} t={t} />);
    expect(
      screen.getByTestId("repo-status-bar").classList.contains(
        repoStyles.warn as string,
      ),
    ).toBe(true);
  });

  it("keeps the branch copy button compact inside the bar", () => {
    render(<RepoStatusBar status={gitStatus()} t={t} />);

    const copy = screen.getByRole("button", { name: "sourceCopyBranch" });
    // `.copy-button` stays a shared global primitive owned by CopyButton; the
    // bar only supplies its own class through the documented pass-through.
    expect(copy.classList.contains("copy-button")).toBe(true);
    expect(copy.classList.contains(repoStyles.copyButton as string)).toBe(true);
  });

  it("offers the dirty badge as a button only when it can open Changes", () => {
    const onSelectChanges = vi.fn();
    const dirty = gitStatus({ isClean: false });
    const { rerender } = render(
      <RepoStatusBar status={dirty} onSelectChanges={onSelectChanges} t={t} />,
    );

    fireEvent.click(screen.getByRole("button", { name: "gitStatusDirty" }));
    expect(onSelectChanges).toHaveBeenCalledTimes(1);

    rerender(<RepoStatusBar status={dirty} t={t} />);
    expect(screen.queryByRole("button", { name: "gitStatusDirty" })).toBeNull();
    expect(screen.getByText("gitStatusDirty")).toBeDefined();
  });
});

describe("SourceModeTabs", () => {
  it("exposes tablist semantics and the selected tab", () => {
    const onSelect = vi.fn();
    render(
      <SourceModeTabs tab="files" tabs={TABS} onSelect={onSelect} t={t} />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(3);
    expect(
      tabs.map((tab) => tab.getAttribute("aria-selected")),
    ).toEqual(["false", "true", "false"]);

    fireEvent.click(tabs[0] as HTMLElement);
    expect(onSelect).toHaveBeenCalledWith("changes");
  });

  it("renders a count chip only for a positive count", () => {
    render(
      <SourceModeTabs
        tab="changes"
        tabs={TABS}
        counts={{ changes: 3, comments: 0 }}
        onSelect={vi.fn()}
        t={t}
      />,
    );

    const counts = document.querySelectorAll(`.${tabStyles.count as string}`);
    expect(counts).toHaveLength(1);
    expect(counts[0]?.textContent).toBe("3");
  });

  it("selects the stacked phone layout by variant rather than by caller CSS", () => {
    const { rerender } = render(
      <SourceModeTabs tab="changes" tabs={TABS} onSelect={vi.fn()} t={t} />,
    );

    const header = screen.getByRole("tablist");
    expect(header.classList.contains(tabStyles.stacked as string)).toBe(false);

    rerender(
      <SourceModeTabs
        tab="changes"
        tabs={TABS}
        variant="stacked"
        onSelect={vi.fn()}
        t={t}
      />,
    );
    expect(
      screen.getByRole("tablist").classList.contains(
        tabStyles.stacked as string,
      ),
    ).toBe(true);
  });
});

describe("SourceRowMenuTrigger", () => {
  it("reveals through a surface class the row opts into, not a row-owned rule", () => {
    expect(sourceRowMenuSurface).toBe(menuStyles.rowSurface);
    expect(sourceRowMenuSurface).not.toBe("");

    const onOpen = vi.fn();
    render(
      <li className={`commit-file-row ${sourceRowMenuSurface}`}>
        <SourceRowMenuTrigger actions={[]} label="sourceRowActions" onOpen={onOpen} />
      </li>,
    );

    const row = document.querySelector("li") as HTMLElement;
    expect(row.classList.contains(sourceRowMenuSurface)).toBe(true);

    const trigger = screen.getByRole("button", { name: "sourceRowActions" });
    expect(trigger.classList.contains(menuStyles.trigger as string)).toBe(true);
    expect(trigger.classList.contains("source-row-menu-trigger")).toBe(false);

    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
