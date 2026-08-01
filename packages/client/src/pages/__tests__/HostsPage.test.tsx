// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { HostsPage, HostsRoute } from "../HostsPage";

const routeState = vi.hoisted(() => ({
  basePath: "",
  enabled: false,
}));

vi.mock("../../hooks/useDeveloperMode", () => ({
  useDeveloperMode: () => ({
    crossHostDelegationEnabled: routeState.enabled,
  }),
}));

vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => routeState.basePath,
}));

vi.mock("../../layouts", () => ({
  MainContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useNavigationLayout: () => ({
    openSidebar: vi.fn(),
    isWideScreen: true,
    toggleSidebar: vi.fn(),
    isSidebarCollapsed: false,
  }),
}));

vi.mock("../../components/PageHeader", () => ({
  PageHeader: ({
    title,
    actions,
  }: {
    title: string;
    actions?: ReactNode;
  }) => (
    <header>
      {title}
      {actions}
    </header>
  ),
}));

describe("HostsPage", () => {
  beforeEach(() => {
    routeState.basePath = "";
    routeState.enabled = false;
  });

  afterEach(() => cleanup());

  it("renders a connection-independent server preview", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <HostsPage />
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("YA Hosts")).toBeTruthy();
    expect(screen.getByText("Experimental")).toBeTruthy();
    expect(screen.getByText("This YA server")).toBeTruthy();
    expect(screen.getByText("One server, multiple access paths")).toBeTruthy();
    expect(screen.getByText("This server can delegate to")).toBeTruthy();
    expect(screen.getByText("May delegate to this server")).toBeTruthy();
    expect(
      screen.getAllByText("Not available in this preview"),
    ).toHaveLength(2);
  });

  it.each([
    { basePath: "", hostsPath: "/-/hosts", projectsPath: "/projects" },
    {
      basePath: "/relay-user",
      hostsPath: "/relay-user/-/hosts",
      projectsPath: "/relay-user/projects",
    },
  ])(
    "redirects a disabled direct route at $hostsPath",
    ({ basePath, hostsPath, projectsPath }) => {
      routeState.basePath = basePath;
      render(
        <MemoryRouter initialEntries={[hostsPath]}>
          <Routes>
            <Route path={hostsPath} element={<HostsRoute />} />
            <Route path={projectsPath} element={<p>Projects destination</p>} />
          </Routes>
        </MemoryRouter>,
      );

      expect(screen.getByText("Projects destination")).toBeTruthy();
      expect(screen.queryByTestId("hosts-page")).toBeNull();
    },
  );

  it("renders the direct route when the preview is enabled", () => {
    routeState.enabled = true;
    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/-/hosts"]}>
          <Routes>
            <Route path="/-/hosts" element={<HostsRoute />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByTestId("hosts-page")).toBeTruthy();
  });
});
