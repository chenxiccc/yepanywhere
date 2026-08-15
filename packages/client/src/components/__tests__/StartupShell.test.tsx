import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { StartupShell, isSessionStartupPath } from "../StartupShell";

describe("StartupShell", () => {
  it("recognizes direct and relay selected-session routes", () => {
    expect(isSessionStartupPath("/projects/project-1/sessions/session-1")).toBe(
      true,
    );
    expect(
      isSessionStartupPath(
        "/-/relay/host/projects/project-1/sessions/session-1",
      ),
    ).toBe(true);
    expect(isSessionStartupPath("/projects/project-1")).toBe(false);
    expect(isSessionStartupPath("/share/secret")).toBe(false);
  });

  it("keeps session-shaped geometry around module status", () => {
    const { container } = render(
      <MemoryRouter
        initialEntries={["/-/relay/host/projects/project-1/sessions/session-1"]}
      >
        <StartupShell phase="module">Loading…</StartupShell>
      </MemoryRouter>,
    );

    expect(screen.getByRole("status").textContent).toContain("Loading…");
    expect(
      container.firstElementChild?.getAttribute("data-startup-shell"),
    ).toBe("session");
    expect(
      container.firstElementChild?.getAttribute("data-startup-phase"),
    ).toBe("module");
  });

  it("uses the simpler page shell away from a selected session", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/login"]}>
        <StartupShell phase="connection">Reconnecting...</StartupShell>
      </MemoryRouter>,
    );

    expect(
      container.firstElementChild?.getAttribute("data-startup-shell"),
    ).toBe("page");
  });
});
