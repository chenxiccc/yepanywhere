// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getAgentSession } = vi.hoisted(() => ({
  getAgentSession: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: { getAgentSession },
}));

vi.mock("../../hooks/useProcesses", () => ({
  useProcesses: () => ({
    processes: [],
    terminatedProcesses: [],
    loading: false,
    error: null,
  }),
}));

vi.mock("../renderers/tools/TaskNestedContent", () => ({
  TaskNestedContent: ({ messages }: { messages: Array<{ id?: string }> }) => (
    <div>child messages {messages.length}</div>
  ),
}));

import { I18nProvider } from "../../i18n";
import { clearCurrentSessionViewer } from "../../lib/sessionViewerController";
import { ProviderChildSessionControl } from "../ProviderChildSessionControl";
import { SessionViewerProvider } from "../SessionManagedViewer";

const NOW_MS = Date.parse("2026-08-17T12:00:00.000Z");

function child(id: string, title: string, updatedAtMs: number) {
  return {
    id,
    parentSessionId: "sess-1",
    title,
    agentType: "Explore",
    updatedAt: new Date(updatedAtMs).toISOString(),
  };
}

function renderControl(
  childrenFromSession = [child("child-1", "Inspect the tree", NOW_MS)],
  processState = "in-turn",
) {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <SessionViewerProvider sessionId="sess-1">
          <ProviderChildSessionControl
            projectId="proj-1"
            sessionId="sess-1"
            basePath=""
            childrenFromSession={childrenFromSession}
            processState={processState}
          />
        </SessionViewerProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("ProviderChildSessionControl", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW_MS);
    getAgentSession.mockReset();
    getAgentSession.mockImplementation(
      (_projectId: string, _sessionId: string, agentId: string) =>
        Promise.resolve({
          messages: [{ id: `${agentId}-message`, type: "assistant" }],
          status: "completed",
          agentType: "Explore",
          description:
            agentId === "child-2" ? "Review tests" : "Inspect the tree",
        }),
    );
  });

  afterEach(() => {
    act(() => clearCurrentSessionViewer());
    cleanup();
    vi.useRealTimers();
  });

  it("omits the control when the parent has no provider children", () => {
    renderControl([]);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("ages the recently-active count once per minute without fetching", async () => {
    renderControl([
      child("child-1", "Inspect the tree", NOW_MS - 2.5 * 60_000),
    ]);

    expect(
      screen.getByRole("button", {
        name: "1 recently active of 1 subagent",
      }).textContent,
    ).toContain("1/1");
    expect(getAgentSession).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(
      screen.getByRole("button", { name: "1 provider subagent" }).textContent,
    ).not.toContain("/");
    expect(getAgentSession).not.toHaveBeenCalled();
  });

  it("opens, selects, minimizes, and restores through the shared viewer", async () => {
    renderControl([
      child("child-1", "Inspect the tree", NOW_MS - 60_000),
      child("child-2", "Review tests", NOW_MS),
    ]);

    const trigger = screen.getByRole("button", {
      name: "2 recently active of 2 subagents",
    });
    fireEvent.click(trigger);

    expect(await screen.findByRole("dialog")).toBeTruthy();
    await waitFor(() =>
      expect(getAgentSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        "child-2",
      ),
    );
    expect(screen.getByText("child messages 1")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Open in new tab" }),
    ).toHaveProperty(
      "href",
      expect.stringContaining(
        "/projects/proj-1/sessions/sess-1/agents/child-2",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: /^Inspect the tree/ }));
    await waitFor(() =>
      expect(getAgentSession).toHaveBeenCalledWith(
        "proj-1",
        "sess-1",
        "child-1",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "Minimize" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(trigger);
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(
      screen
        .getByRole("button", { name: /^Inspect the tree/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });
});
