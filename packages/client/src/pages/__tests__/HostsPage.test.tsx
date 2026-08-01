// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { HostsPage } from "../HostsPage";

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
});
