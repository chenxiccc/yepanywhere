// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { ConnectionBar } from "../ConnectionBar";

const state = vi.hoisted(() => ({
  connectionState: "connected" as "connected" | "reconnecting" | "disconnected",
  showConnectionBars: true,
}));

vi.mock("../../hooks/useActivityBusState", () => ({
  useActivityBusState: () => ({ connectionState: state.connectionState }),
}));

vi.mock("../../hooks/useDeveloperMode", () => ({
  useDeveloperMode: () => ({ showConnectionBars: state.showConnectionBars }),
}));

beforeEach(() => {
  state.connectionState = "connected";
  state.showConnectionBars = true;
});

afterEach(() => {
  cleanup();
});

function renderConnectionBar(path = "/") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ConnectionBar />
    </MemoryRouter>,
  );
}

describe("ConnectionBar", () => {
  it("does not render a full-width success rule for a healthy connection", () => {
    const { container } = renderConnectionBar();

    expect(container.querySelector("[data-connection-status]")).toBeNull();
  });

  it.each(["reconnecting", "disconnected"] as const)(
    "renders the %s exceptional state",
    (connectionState) => {
      state.connectionState = connectionState;

      const { container } = renderConnectionBar();

      const renderedStatus =
        connectionState === "reconnecting" ? "connecting" : connectionState;
      expect(
        container.querySelector(`[data-connection-status="${renderedStatus}"]`),
      ).not.toBeNull();
    },
  );

  it("stays hidden on login routes", () => {
    state.connectionState = "disconnected";

    const { container } = renderConnectionBar("/login");

    expect(container.querySelector("[data-connection-status]")).toBeNull();
  });
});
