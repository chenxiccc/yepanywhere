// @vitest-environment jsdom

import type { ProjectQueueItemSummary } from "@yep-anywhere/shared";
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import queueStyles from "../../components/ProjectQueueSection.module.css";
import { I18nProvider } from "../../i18n";
import { PROJECT_QUEUE_CAPABILITY } from "../../lib/projectQueueVisibility";
import { ProjectsPage } from "../ProjectsPage";

const state = vi.hoisted(() => ({
  projects: [
    {
      id: "project-1",
      name: "Alpha",
      path: "/tmp/alpha",
      sessionCount: 2,
      activeOwnedCount: 0,
      activeExternalCount: 0,
      lastActivity: null,
    },
  ],
  queueItems: [] as ProjectQueueItemSummary[],
  projectStatusesByProject: {},
  dispatchState: { status: "running" as const },
  inboxCountsByProject: new Map<
    string,
    { needsAttention: number; active: number; total: number }
  >(),
  version: { capabilities: [] as string[] } as {
    capabilities?: string[];
    remoteCompatibilityLevel?: number;
  },
  isRemoteClient: false,
  mockUseProjectQueues: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    addProject: vi.fn(),
    deleteProject: vi.fn(),
  },
}));

vi.mock("../../lib/clientSummaryStore", () => ({
  useInboxCountsByProject: () => state.inboxCountsByProject,
}));

vi.mock("../../hooks/useProjects", () => ({
  useProjects: () => ({
    projects: state.projects,
    loading: false,
    error: null,
    refetch: vi.fn(),
  }),
}));

vi.mock("../../hooks/useProjectQueues", () => ({
  useProjectQueues: (projectIds: readonly string[]) => {
    state.mockUseProjectQueues(projectIds);
    return {
      queuesByProject: { "project-1": state.queueItems },
      items: state.queueItems,
      projectStatusesByProject: state.projectStatusesByProject,
      recoveredSessionQueues: [],
      loading: false,
      error: null,
      mutatingItemId: null,
      mutatingDispatchState: false,
      mutatingPromoteItemId: null,
      dispatchState: state.dispatchState,
      refetch: vi.fn(),
      pauseDispatch: vi.fn(),
      resumeDispatch: vi.fn(),
      promoteNow: vi.fn(),
      updateItem: vi.fn(),
      deleteItem: vi.fn(),
      retryItem: vi.fn(),
      moveItemToTop: vi.fn(),
    };
  },
}));

vi.mock("../../hooks/useVersion", () => ({
  useVersion: () => ({ version: state.version }),
}));

vi.mock("../../lib/connection", () => ({
  isRemoteClient: () => state.isRemoteClient,
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

vi.mock("../../layouts", () => ({
  MainContent: ({ children }: { children: ReactNode }) => (
    <main>{children}</main>
  ),
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
    toggleSidebar: vi.fn(),
    isSidebarCollapsed: false,
  }),
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({ title }: { title: string }) => <header>{title}</header>,
}));

function makeItem(status: ProjectQueueItemSummary["status"]) {
  return {
    id: "queue-1",
    projectId: "project-1" as ProjectQueueItemSummary["projectId"],
    target: { type: "existing-session", sessionId: "session-abcdef" },
    messagePreview: "Queued project work",
    message: { text: "Queued project work" },
    createdAt: "2026-06-27T00:00:00.000Z",
    updatedAt: "2026-06-27T00:00:00.000Z",
    status,
    attachmentCount: 0,
  } satisfies ProjectQueueItemSummary;
}

describe("ProjectsPage", () => {
  beforeEach(() => {
    state.queueItems = [makeItem("queued")];
    state.projectStatusesByProject = {};
    state.dispatchState = { status: "running" };
    state.inboxCountsByProject = new Map();
    state.version = { capabilities: [PROJECT_QUEUE_CAPABILITY] };
    state.isRemoteClient = false;
    state.mockUseProjectQueues.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders project queue items and project card queue counts", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByRole("heading", { name: "Project Queue" })).toBeTruthy();
    expect(screen.getByText("Queued project work")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    expect(screen.getByTitle("Project Queue items: 1").textContent).toBe("1");
  });

  it("highlights a queue item from the query string", () => {
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/projects?queueItem=queue-1"]}>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    const highlighted = document.querySelector(
      '[data-project-queue-item-id="queue-1"]',
    );
    expect(highlighted?.className).toContain(queueStyles.itemHighlighted);
  });

  it("hides project queue UI without the server capability", () => {
    state.version = { capabilities: [] };

    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(state.mockUseProjectQueues).toHaveBeenCalledWith([]);
    expect(screen.queryByRole("heading", { name: "Project Queue" })).toBe(null);
    expect(screen.queryByText("Queued project work")).toBe(null);
    expect(screen.queryByTitle("Project Queue items: 1")).toBe(null);
  });

  it("hides project queue UI for hosted remote servers below the compatible level", () => {
    state.isRemoteClient = true;
    state.version = {
      capabilities: [PROJECT_QUEUE_CAPABILITY],
      remoteCompatibilityLevel: 0,
    };

    render(
      <I18nProvider>
        <MemoryRouter>
          <ProjectsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(state.mockUseProjectQueues).toHaveBeenCalledWith([]);
    expect(screen.queryByRole("heading", { name: "Project Queue" })).toBe(null);
    expect(screen.queryByText("Queued project work")).toBe(null);
    expect(screen.queryByTitle("Project Queue items: 1")).toBe(null);
  });
});
