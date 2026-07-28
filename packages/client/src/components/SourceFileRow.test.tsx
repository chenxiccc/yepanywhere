// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../lib/storageKeys";
import {
  SourceFilePath,
  SourceFileRowButton,
  SourceFileStatusBadge,
} from "./SourceFileRow";

const t = (key: string) => key;

describe("SourceFileRow", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("puts the full native tooltip on the actual row target", () => {
    render(
      <SourceFileRowButton path="src/a/very-long-file-name.ts">
        <SourceFilePath>src/a/very-long-file-name.ts</SourceFilePath>
      </SourceFileRowButton>,
    );

    const row = screen.getByRole("button");
    expect(row.getAttribute("title")).toBe("src/a/very-long-file-name.ts");
    expect(row.getAttribute("data-tooltip")).toBeNull();
  });

  it("puts the full themed tooltip on the actual row target", () => {
    localStorage.setItem(UI_KEYS.tooltipMode, "themed");
    render(
      <SourceFileRowButton path="src/a/very-long-file-name.ts">
        <SourceFilePath>src/a/very-long-file-name.ts</SourceFilePath>
      </SourceFileRowButton>,
    );

    const row = screen.getByRole("button");
    expect(row.getAttribute("data-tooltip")).toBe(
      "src/a/very-long-file-name.ts",
    );
    expect(row.getAttribute("title")).toBeNull();
  });

  it("expands a compact git status code", () => {
    render(<SourceFileStatusBadge status="M" t={t} />);

    const badge = screen.getByText("M");
    expect(badge.getAttribute("title")).toBe(
      "M — sourceFileStatusModified",
    );
    expect(badge.getAttribute("aria-label")).toBe(
      "M — sourceFileStatusModified",
    );
  });
});
