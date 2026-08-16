// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentsPage } from "../AgentsPage";

const { abortProcess, hostProcessesState, processesState, refetch } =
  vi.hoisted(() => ({
    abortProcess: vi.fn(),
    refetch: vi.fn(async () => undefined),
    hostProcessesState: {
      enabled: true,
      supported: true as boolean | null,
      observations: [] as Array<{
        observationId: string;
        pid: number;
        provider: "claude" | "codex";
        supervision: "ya" | "external";
        supervisorProcessId?: string;
        startedAt: string;
        sampledAt: string;
        cpu?: { rootPercent: number; treePercent: number; windowMs: number };
        memory: {
          rootRssBytes: number;
          treeRssBytes: number;
          descendantCount: number;
        };
      }>,
      loading: false,
      error: false,
    },
    processesState: {
      processes: [
        {
          id: "process-1",
          sessionId: "session-1",
          projectId: "project-1",
          projectPath: "/tmp/project",
          projectName: "project",
          state: "idle" as const,
          startedAt: "2026-07-19T12:00:00.000Z",
          queueDepth: 0,
          sessionTitle: "Codex session",
          provider: "codex" as const,
          pid: 43210,
          providerChildren: [
            {
              id: "child-native-1",
              parentSessionId: "session-1",
              title: "Review the restart guard",
              agentType: "reviewer",
              updatedAt: "2026-07-19T12:01:00.000Z",
            },
          ],
        },
      ],
      terminatedProcesses: [],
      loading: false,
      error: null as Error | null,
    },
  }));

vi.mock("../../api/client", () => ({
  api: { abortProcess },
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

vi.mock("../../components/ThinkingIndicator", () => ({
  ThinkingIndicator: () => <span>thinking</span>,
}));

vi.mock("../../hooks/useProcesses", () => ({
  useProcesses: () => ({ ...processesState, refetch }),
}));

vi.mock("../../hooks/useHostAgentProcesses", () => ({
  useHostAgentProcesses: () => hostProcessesState,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../i18n", () => ({
  useI18n: () => ({
    t: (key: string, values?: Record<string, string | number>) => {
      const templates: Record<string, string> = {
        agentsTitle: "Agents",
        agentsSectionActive: "Active",
        agentsSectionExternal: "External",
        agentsSectionIdle: "Idle",
        agentsSectionStopped: "Stopped",
        agentsEmptyActive: "No active agents",
        agentsEmptyExternal: "No external agent processes",
        agentsEmptyStopped: "No stopped agents",
        agentsIdle: "Idle",
        agentsPid: "PID {pid}",
        agentsExternalProcessTitle: "{provider} process",
        agentsOutsideYa: "Outside YA",
        agentsMetricsCpuValue: "{percent} CPU",
        agentsMetricsCpuSampling: "Sampling CPU…",
        agentsMetricsManagedYa: "Managed by: YA",
        agentsMetricsManagedExternal: "Managed by: Outside YA",
        agentsMetricsProvider: "Provider: {provider}",
        agentsMetricsStarted: "Started: {value}",
        agentsMetricsAge: "Age: {value}",
        agentsMetricsRecentCpu:
          "Recent CPU: {treePercent} process tree; {percent} root over {seconds}s",
        agentsMetricsRootRss: "Root RSS: {value}",
        agentsMetricsTreeRss: "Process tree RSS: {value}",
        agentsMetricsDescendants: "Descendants: {count}",
        agentsMetricsSampled: "Sampled: {value}",
        agentsKill: "Kill",
        agentsKilling: "Killing…",
        agentsKillTitle: "Force-stop this agent process",
        agentsKillConfirm: "Kill {title}?",
        agentsKillVerifiedPid:
          "Stopped PID {pid} and verified it is no longer running.",
        agentsKillResumeBlocked: "Auto-resume disabled for the killed session.",
        agentsKillResumeBlockFailed:
          "The process stopped, but auto-resume could not be disabled: {message}",
        agentsKillResumeBlockUnknown: "Unknown exemption error",
        agentsKillFailed: "Could not stop the agent: {message}",
        providerChildrenCountOne: "{count} provider subagent",
        providerChildrenCountMany: "{count} provider subagents",
        providerChildFallback: "Provider subagent",
      };
      return Object.entries(values ?? {}).reduce(
        (text, [name, value]) => text.replace(`{${name}}`, String(value)),
        templates[key] ?? key,
      );
    },
  }),
}));

vi.mock("../../layouts", () => ({
  MainContent: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
  }),
}));

describe("AgentsPage process kill", () => {
  beforeEach(() => {
    abortProcess.mockReset();
    refetch.mockClear();
    hostProcessesState.enabled = true;
    hostProcessesState.supported = true;
    hostProcessesState.observations = [];
    hostProcessesState.loading = false;
    hostProcessesState.error = false;
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("nests provider-launched child work under its parent process", () => {
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("Review the restart guard")).toBeTruthy();
    expect(screen.getByText("reviewer")).toBeTruthy();
    expect(
      screen.getByRole("list", { name: "1 provider subagent" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Review the restart guard/ }),
    ).toBeTruthy();
  });

  it("decorates owned rows and shows external process trees without controls", () => {
    hostProcessesState.observations = [
      {
        observationId: "43210:1",
        pid: 43210,
        provider: "codex",
        supervision: "ya",
        supervisorProcessId: "process-1",
        startedAt: "2026-07-19T12:00:00.000Z",
        sampledAt: "2026-07-28T12:00:00.000Z",
        cpu: { rootPercent: 3.2, treePercent: 5.1, windowMs: 5_000 },
        memory: {
          rootRssBytes: 100 * 1024 * 1024,
          treeRssBytes: 130 * 1024 * 1024,
          descendantCount: 1,
        },
      },
      {
        observationId: "9876:1",
        pid: 9876,
        provider: "claude",
        supervision: "external",
        startedAt: "2026-07-28T11:30:00.000Z",
        sampledAt: "2026-07-28T12:00:00.000Z",
        cpu: { rootPercent: 8.4, treePercent: 9.7, windowMs: 5_000 },
        memory: {
          rootRssBytes: 200 * 1024 * 1024,
          treeRssBytes: 240 * 1024 * 1024,
          descendantCount: 2,
        },
      },
    ];

    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    expect(screen.getByText("External")).toBeTruthy();
    expect(screen.getByText("Claude process")).toBeTruthy();
    expect(screen.getByText("Outside YA")).toBeTruthy();
    expect(screen.getByText("PID 9876")).toBeTruthy();
    expect(screen.getAllByText("100 MiB RSS")).toHaveLength(1);
    expect(screen.getAllByText("200 MiB RSS")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Kill" })).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", {
        name: /Managed by: Outside YA/,
      }),
    );
    expect(screen.getByRole("status").textContent).toContain(
      "Process tree RSS: 240 MiB",
    );
    expect(screen.getByRole("status").textContent).not.toMatch(
      /command|environment/i,
    );
  });

  it("toggles external metrics from a quiet card tap on touch screens", () => {
    hostProcessesState.observations = [
      {
        observationId: "9876:1",
        pid: 9876,
        provider: "claude",
        supervision: "external",
        startedAt: "2026-07-28T11:30:00.000Z",
        sampledAt: "2026-07-28T12:00:00.000Z",
        cpu: { rootPercent: 8.4, treePercent: 9.7, windowMs: 5_000 },
        memory: {
          rootRssBytes: 200 * 1024 * 1024,
          treeRssBytes: 240 * 1024 * 1024,
          descendantCount: 2,
        },
      },
    ];

    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    const card = screen.getByText("Claude process").closest("article");
    expect(card).toBeTruthy();
    const touchPointerUp = () => {
      const event = new Event("pointerup", { bubbles: true });
      Object.defineProperty(event, "pointerType", { value: "touch" });
      return event;
    };
    fireEvent(card as HTMLElement, touchPointerUp());
    expect(screen.getByRole("status").textContent).toContain(
      "Process tree RSS: 240 MiB",
    );

    fireEvent(card as HTMLElement, touchPointerUp());
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("reports the PID after shutdown is verified", async () => {
    abortProcess.mockResolvedValue({
      aborted: true,
      processId: "process-1",
      sessionId: "session-1",
      pid: 43210,
      verifiedStopped: true,
      verification: "pid",
    });
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Kill" }));

    await waitFor(() => {
      expect(abortProcess).toHaveBeenCalledWith("process-1", {
        blockResume: true,
      });
    });
    expect((await screen.findByRole("status")).textContent).toContain(
      "Stopped PID 43210 and verified it is no longer running.",
    );
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("notes the resume exemption when the server reports one", async () => {
    abortProcess.mockResolvedValue({
      aborted: true,
      processId: "process-1",
      sessionId: "session-1",
      pid: 43210,
      verifiedStopped: true,
      verification: "pid",
      resumeExemption: {
        heartbeatDisabled: true,
        autoResumeDisabled: true,
      },
    });
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Kill" }));

    expect((await screen.findByRole("status")).textContent).toContain(
      "Auto-resume disabled for the killed session.",
    );
  });

  it("reports a resume exemption failure after verified shutdown", async () => {
    abortProcess.mockResolvedValue({
      aborted: true,
      processId: "process-1",
      sessionId: "session-1",
      pid: 43210,
      verifiedStopped: true,
      verification: "pid",
      resumeExemption: {
        heartbeatDisabled: false,
        autoResumeDisabled: false,
        error: "metadata is read-only",
      },
    });
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Kill" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "The process stopped, but auto-resume could not be disabled: metadata is read-only",
    );
  });

  it("surfaces a failed shutdown verification", async () => {
    abortProcess.mockRejectedValue(
      new Error("Provider PID 43210 is still running after abort"),
    );
    render(
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Kill" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not stop the agent: Provider PID 43210 is still running after abort",
    );
    expect(refetch).toHaveBeenCalledOnce();
  });
});
