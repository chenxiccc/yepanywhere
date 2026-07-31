// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FilterDropdown } from "../FilterDropdown";
import styles from "../FilterDropdown.module.css";

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string) => key,
  }),
}));

const DESKTOP_WIDTH = 1024;
const PHONE_WIDTH = 375;

function setViewportWidth(width: number) {
  Object.defineProperty(window, "innerWidth", {
    configurable: true,
    writable: true,
    value: width,
  });
}

function openTrigger() {
  fireEvent.click(screen.getByRole("button", { name: "filterByLabel" }));
}

describe("FilterDropdown", () => {
  afterEach(() => {
    cleanup();
    setViewportWidth(DESKTOP_WIDTH);
    document.body.style.overflow = "";
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

  it("toggles open and closed from the trigger", () => {
    render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    openTrigger();
    expect(screen.getByRole("dialog")).toBeTruthy();
    openTrigger();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on Escape", () => {
    render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );

    openTrigger();
    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("closes on a click outside the desktop dropdown", () => {
    render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );

    openTrigger();
    fireEvent.mouseDown(document.body);

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("selects a single value and closes", () => {
    const onChange = vi.fn();
    render(
      <FilterDropdown
        label="Models"
        options={[
          { value: "fable", label: "Fable" },
          { value: "opus", label: "Opus" },
        ]}
        selected={[]}
        onChange={onChange}
        multiSelect={false}
      />,
    );

    openTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Opus" }));

    expect(onChange).toHaveBeenCalledWith(["opus"]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("accumulates multi-select values and stays open", () => {
    const onChange = vi.fn();
    render(
      <FilterDropdown
        label="Status"
        options={[
          { value: "unread", label: "Unread" },
          { value: "starred", label: "Starred" },
        ]}
        selected={["unread"]}
        onChange={onChange}
      />,
    );

    openTrigger();
    fireEvent.click(screen.getByRole("button", { name: "Starred" }));

    expect(onChange).toHaveBeenCalledWith(["unread", "starred"]);
    expect(screen.getByRole("dialog")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "filterClearAll" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("aligns the desktop dropdown to the right on request", () => {
    render(
      <FilterDropdown
        label="Interface"
        options={[{ value: "lan", label: "LAN" }]}
        selected={[]}
        onChange={vi.fn()}
        align="right"
      />,
    );

    openTrigger();

    expect(screen.getByRole("dialog").className).toContain(styles.alignRight);
  });

  it("renders the narrow-viewport sheet through a portal", () => {
    setViewportWidth(PHONE_WIDTH);
    const { container } = render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
      />,
    );

    openTrigger();

    const sheet = screen.getByRole("dialog");
    // The sheet mounts on document.body, not inside the component's container.
    expect(container.contains(sheet)).toBe(false);
    expect(document.body.contains(sheet)).toBe(true);
    expect(sheet.className).toContain(styles.sheet);
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("applies the full-width variant to the container and trigger", () => {
    const { container } = render(
      <FilterDropdown
        label="Model"
        options={[{ value: "fable", label: "Fable" }]}
        selected={[]}
        onChange={vi.fn()}
        fullWidth
      />,
    );

    const root = container.firstElementChild;
    const trigger = screen.getByRole("button", { name: "filterByLabel" });

    expect(root?.className).toContain(styles.fullWidth);
    expect(trigger.className).toContain(styles.fullWidth);
  });

  it("applies caller trigger classes without exposing internals", () => {
    render(
      <FilterDropdown
        label="Status"
        options={[{ value: "unread", label: "Unread" }]}
        selected={[]}
        onChange={vi.fn()}
        triggerClassName="filter-dropdown-trigger--status"
      />,
    );

    expect(
      screen.getByRole("button", { name: "filterByLabel" }).className,
    ).toContain("filter-dropdown-trigger--status");
  });
});
