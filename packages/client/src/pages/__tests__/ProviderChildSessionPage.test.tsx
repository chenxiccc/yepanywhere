// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAgentSession } = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { getAgentSession },
}));

vi.mock("../../components/renderers/tools/TaskNestedContent", () => ({
  TaskNestedContent: ({ messages }: { messages: Array<{ id?: string }> }) => (
    <div>child messages {messages.length}</div>
  ),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

import { I18nProvider } from "../../i18n";
import { ProviderChildSessionPage } from "../ProviderChildSessionPage";

describe("ProviderChildSessionPage", () => {
  beforeEach(() => {
    getAgentSession.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("loads the existing agent transcript as a read-only page", async () => {
    getAgentSession.mockResolvedValue({
      messages: [{ id: "m1", type: "assistant", content: "done" }],
      status: "completed",
      agentType: "Explore",
      description: "Search the repo",
    });

    render(
      <I18nProvider>
        <MemoryRouter
          initialEntries={["/projects/proj-1/sessions/sess-1/agents/child-1"]}
        >
          <Routes>
            <Route
              path="/projects/:projectId/sessions/:sessionId/agents/:agentId"
              element={<ProviderChildSessionPage />}
            />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText("Search the repo")).toBeTruthy();
    });
    expect(getAgentSession).toHaveBeenCalledWith("proj-1", "sess-1", "child-1");
    expect(screen.getByText("child messages 1")).toBeTruthy();
    expect(
      screen.getByText("Read-only. This subagent has no input channel."),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Back to parent session" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining("/projects/proj-1/sessions/sess-1"),
    );
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
