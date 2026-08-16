// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../hooks/useProcesses", () => ({
  useProcesses: () => ({
    processes: [],
    terminatedProcesses: [],
    loading: false,
    error: null,
  }),
}));

import { I18nProvider } from "../../i18n";
import { ProviderChildSessionStrip } from "../ProviderChildSessionStrip";

describe("ProviderChildSessionStrip", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows count, last activity, and links to the child page", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ProviderChildSessionStrip
            projectId="proj-1"
            sessionId="sess-1"
            basePath=""
            processState="idle"
            childrenFromSession={[
              {
                id: "child-1",
                parentSessionId: "sess-1",
                title: "Explore the tree",
                agentType: "Explore",
                updatedAt: "2026-08-16T12:00:00.000Z",
              },
            ]}
          />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("1 provider subagent")).toBeTruthy();
    expect(screen.getByText("Explore the tree")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Explore the tree/ }),
    ).toHaveProperty(
      "href",
      expect.stringContaining(
        "/projects/proj-1/sessions/sess-1/agents/child-1",
      ),
    );
  });
});
