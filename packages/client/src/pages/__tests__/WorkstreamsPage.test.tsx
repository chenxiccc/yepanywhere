// @vitest-environment jsdom

import type { ProjectWorkstreamsResponse } from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { I18nProvider } from "../../i18n";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkstreamsPage } from "../WorkstreamsPage";

const state = vi.hoisted(() => ({
  settings: { workstreamsEnabled: true } as {
    workstreamsEnabled?: boolean;
  } | null,
  settingsLoading: false,
  settingsError: null as string | null,
  getProjectWorkstreams: vi.fn(),
  getProjectWorkstreamCheckoutPreview: vi.fn(),
  createProjectWorkstream: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getProjectWorkstreams: state.getProjectWorkstreams,
    getProjectWorkstreamCheckoutPreview:
      state.getProjectWorkstreamCheckoutPreview,
    createProjectWorkstream: state.createProjectWorkstream,
  },
}));

vi.mock("../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: state.settings,
    isLoading: state.settingsLoading,
    error: state.settingsError,
    updateSettings: vi.fn(),
    updateSetting: vi.fn(),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../layouts", () => ({
  MainContent: ({
    children,
    innerClassName,
  }: {
    children: ReactNode;
    innerClassName?: string;
  }) => <div className={innerClassName}>{children}</div>,
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

function makeResponse(
  workstreams: ProjectWorkstreamsResponse["workstreams"],
): ProjectWorkstreamsResponse {
  return {
    projectId: "project-1",
    workstreams,
  } as ProjectWorkstreamsResponse;
}

function mainWorkstream(): ProjectWorkstreamsResponse["workstreams"][number] {
  return {
    id: "main:project-1",
    projectId: "project-1",
    label: "Main checkout",
    kind: "main",
    path: "/repo/project",
    branch: "main",
    baseBranch: "main",
    baseCommit: null,
    managedByYa: false,
    queuePaused: false,
    status: "active",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  } as ProjectWorkstreamsResponse["workstreams"][number];
}

function checkoutWorkstream(): ProjectWorkstreamsResponse["workstreams"][number] {
  return {
    id: "checkout-1",
    projectId: "project-1",
    label: "Feature checkout",
    kind: "checkout",
    path: "/repo/project-feature",
    branch: "feature/refactor",
    baseBranch: "main",
    baseCommit: "abc1234",
    managedByYa: true,
    queuePaused: true,
    status: "active",
    createdAt: "2026-07-02T00:00:00.000Z",
    updatedAt: "2026-07-02T00:00:00.000Z",
  } as ProjectWorkstreamsResponse["workstreams"][number];
}

function renderPage() {
  return render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/projects/project-1/workstreams"]}>
        <Routes>
          <Route
            path="/projects/:projectId/workstreams"
            element={<WorkstreamsPage />}
          />
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("WorkstreamsPage", () => {
  beforeEach(() => {
    state.settings = { workstreamsEnabled: true };
    state.settingsLoading = false;
    state.settingsError = null;
    state.getProjectWorkstreams.mockReset();
    state.getProjectWorkstreamCheckoutPreview.mockReset();
    state.createProjectWorkstream.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not fetch while workstreams are disabled", () => {
    state.settings = { workstreamsEnabled: false };

    renderPage();

    expect(screen.getByText("Workstreams are turned off")).toBeTruthy();
    expect(state.getProjectWorkstreams).not.toHaveBeenCalled();
  });

  it("renders main and checkout lanes", async () => {
    state.getProjectWorkstreams.mockResolvedValue(
      makeResponse([mainWorkstream(), checkoutWorkstream()]),
    );

    renderPage();

    expect(state.getProjectWorkstreams).toHaveBeenCalledWith("project-1");
    expect(await screen.findByText("Main checkout")).toBeTruthy();
    expect(screen.getByText("Feature checkout")).toBeTruthy();
    expect(screen.getByText("/repo/project-feature")).toBeTruthy();
    expect(screen.getByText("feature/refactor")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByText("Paused")).toBeTruthy();
    expect(screen.getByRole("columnheader", { name: "Sessions" })).toBeTruthy();
  });

  it("renders no-access state for missing projects", async () => {
    state.getProjectWorkstreams.mockRejectedValue(
      Object.assign(new Error("Project not found"), { status: 404 }),
    );

    renderPage();

    expect(await screen.findByText("Project unavailable")).toBeTruthy();
    expect(
      screen.getByText("This project is unavailable or cannot be shown here."),
    ).toBeTruthy();
  });

  it("renders an empty state when no lanes are returned", async () => {
    state.getProjectWorkstreams.mockResolvedValue(makeResponse([]));

    renderPage();

    await waitFor(() =>
      expect(screen.getByText("No checkout lanes")).toBeTruthy(),
    );
  });

  it("previews and creates a checkout lane", async () => {
    state.getProjectWorkstreams.mockResolvedValue(
      makeResponse([mainWorkstream()]),
    );
    state.getProjectWorkstreamCheckoutPreview.mockResolvedValue({
      projectId: "project-1",
      label: "Feature checkout",
      slug: "feature-checkout",
      checkoutRootPath: "/tmp/checkouts/project/feature-checkout",
      checkoutPath: "/tmp/checkouts/project/feature-checkout",
    });
    state.createProjectWorkstream.mockResolvedValue({
      projectId: "project-1",
      workstream: checkoutWorkstream(),
      workstreams: [mainWorkstream(), checkoutWorkstream()],
    });

    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "New workstream" }),
    );
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Feature checkout" },
    });

    expect(
      await screen.findByText("/tmp/checkouts/project/feature-checkout"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() =>
      expect(state.createProjectWorkstream).toHaveBeenCalledWith("project-1", {
        label: "Feature checkout",
      }),
    );
    expect(await screen.findByText("Feature checkout")).toBeTruthy();
  });

  it("shows a busy error when another create is running", async () => {
    state.getProjectWorkstreams.mockResolvedValue(
      makeResponse([mainWorkstream()]),
    );
    state.getProjectWorkstreamCheckoutPreview.mockResolvedValue({
      projectId: "project-1",
      label: "Feature checkout",
      slug: "feature-checkout",
      checkoutRootPath: "/tmp/checkouts/project/feature-checkout",
      checkoutPath: "/tmp/checkouts/project/feature-checkout",
    });
    state.createProjectWorkstream.mockRejectedValue(
      Object.assign(new Error("busy"), { status: 409 }),
    );

    renderPage();

    fireEvent.click(
      await screen.findByRole("button", { name: "New workstream" }),
    );
    fireEvent.change(screen.getByLabelText("Label"), {
      target: { value: "Feature checkout" },
    });
    await screen.findByText("/tmp/checkouts/project/feature-checkout");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(
      await screen.findByText(
        "Another workstream operation is already running for this project.",
      ),
    ).toBeTruthy();
  });
});
