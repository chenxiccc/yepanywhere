// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterDropdown } from "../FilterDropdown";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

describe("FilterDropdown", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders a named boundary before additional model options", () => {
    render(
      <FilterDropdown
        label="Models"
        options={[
          { value: "latest", label: "Latest" },
          {
            value: "previous",
            label: "Previous",
            groupLabelBefore: "Previous models",
          },
        ]}
        selected={["latest"]}
        onChange={vi.fn()}
        multiSelect={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "filterByLabel" }));

    expect(screen.getByText("Previous models")).toBeTruthy();
    expect(screen.getByText("Previous")).toBeTruthy();
  });

  it("renders trailing option metadata", () => {
    render(
      <FilterDropdown
        label="Models"
        options={[
          {
            value: "fable",
            label: "Fable",
            meta: <span>100% used</span>,
          },
        ]}
        selected={[]}
        onChange={vi.fn()}
        multiSelect={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "filterByLabel" }));

    expect(screen.getByText("100% used")).toBeTruthy();
  });
});
