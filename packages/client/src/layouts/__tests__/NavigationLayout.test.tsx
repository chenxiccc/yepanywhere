import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { UI_KEYS } from "../../lib/storageKeys";

const mocks = vi.hoisted(() => ({
  GlossaryProjectProvider: vi.fn(
    ({
      children,
      enabled,
      projectId,
    }: {
      children: ReactNode;
      enabled?: boolean;
      projectId: string;
    }) => (
      <div
        data-testid="glossary-project-provider"
        data-enabled={enabled ? "true" : "false"}
        data-project-id={projectId}
      >
        {children}
      </div>
    ),
  ),
  SidebarSessionFeedsProvider: vi.fn(
    ({ children }: { children: React.ReactNode }) => (
      <div data-testid="sidebar-session-feeds-provider">{children}</div>
    ),
  ),
  Sidebar: vi.fn(
    ({
      isDesktop,
      onMinimize,
    }: {
      isDesktop?: boolean;
      onMinimize?: () => void;
    }) => (
      <div data-testid={isDesktop ? "desktop-sidebar" : "mobile-sidebar"}>
        {onMinimize && (
          <button type="button" onClick={onMinimize}>
            Minimize sidebar
          </button>
        )}
      </div>
    ),
  ),
}));

vi.mock("../../components/Sidebar", () => ({
  Sidebar: mocks.Sidebar,
  SidebarToggleIcon: () => <svg aria-hidden="true" />,
}));

vi.mock("../../contexts/GlossaryContext", () => ({
  GlossaryProjectProvider: mocks.GlossaryProjectProvider,
}));

vi.mock("../../hooks/useSidebarSessionFeeds", () => ({
  SidebarSessionFeedsProvider: mocks.SidebarSessionFeedsProvider,
}));

import {
  NavigationLayout,
  SessionDomLingerRouteMarker,
} from "../NavigationLayout";

function renderNavigationLayout(path = "/agents") {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<NavigationLayout />}>
            <Route
              path="/agents"
              element={<div data-testid="route-content" />}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function renderNavigationLayoutWithSessionLinger(
  path = "/projects/project-1/sessions/session-1",
  options: {
    onSessionRender?: (parked: boolean, sessionId: string) => void;
  } = {},
) {
  render(
    <I18nProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            element={
              <NavigationLayout
                sessionElement={(route, { parked }) => {
                  options.onSessionRender?.(parked, route.sessionId);
                  return (
                    <div
                      data-testid="session-layer"
                      data-session-id={route.sessionId}
                      data-parked={parked ? "true" : "false"}
                    >
                      <Link to="/agents">Agents</Link>
                      <Link to="/projects/project-1/file?path=README.md">
                        File
                      </Link>
                      <Link to="/projects/project-1/sessions/session-2">
                        Session 2
                      </Link>
                    </div>
                  );
                }}
              />
            }
          >
            <Route
              path="/agents"
              element={
                <div data-testid="route-content">
                  <Link to="/projects/project-1/sessions/session-1">
                    Session 1
                  </Link>
                </div>
              }
            />
            <Route
              path="/projects/:projectId/file"
              element={
                <div data-testid="file-frame">
                  <Link to="/projects/project-1/sessions/session-1">
                    Session 1
                  </Link>
                </div>
              }
            />
            <Route
              path="/projects/:projectId/sessions/:sessionId"
              element={<SessionDomLingerRouteMarker />}
            />
          </Route>
        </Routes>
      </MemoryRouter>
    </I18nProvider>,
  );
}

function enableSessionDomLinger() {
  window.localStorage.setItem(UI_KEYS.sessionDomLinger, "true");
}

describe("NavigationLayout", () => {
  beforeEach(() => {
    mocks.GlossaryProjectProvider.mockClear();
    mocks.SidebarSessionFeedsProvider.mockClear();
    mocks.Sidebar.mockClear();
    window.localStorage.clear();
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1024,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("mounts sidebar session coverage once, above everything that reads it", () => {
    renderNavigationLayout();

    const provider = screen.getByTestId("sidebar-session-feeds-provider");
    expect(provider).toBeTruthy();
    // Both the rail and the overlay read the feeds the provider owns, so the
    // provider has to enclose them rather than sit beside them.
    expect(
      provider.querySelector('[data-testid="route-content"]'),
    ).toBeTruthy();
    expect(mocks.SidebarSessionFeedsProvider).toHaveBeenCalledTimes(1);
  });

  it("removes the collapsed desktop rail and restores it from the floating toggle", () => {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      value: 1400,
    });
    window.localStorage.setItem(UI_KEYS.sidebarExpanded, "false");
    renderNavigationLayout();

    expect(screen.getByTestId("desktop-sidebar")).toBeTruthy();

    fireEvent.click(screen.getByText("Minimize sidebar"));

    expect(screen.queryByTestId("desktop-sidebar")).toBeNull();
    const restoreButton = screen.getByRole("button", {
      name: "Restore sidebar",
    });
    expect(restoreButton.classList.contains("sidebar-floating-restore")).toBe(
      true,
    );
    expect(window.localStorage.getItem(UI_KEYS.sidebarMinimized)).toBe("true");

    fireEvent.click(restoreButton);

    expect(screen.getByTestId("desktop-sidebar")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Restore sidebar" }),
    ).toBeNull();
    expect(window.localStorage.getItem(UI_KEYS.sidebarMinimized)).toBe("false");
  });

  it("parks one session DOM layer under a non-session route and reveals it", () => {
    enableSessionDomLinger();
    renderNavigationLayoutWithSessionLinger();

    const sessionLayer = screen.getByTestId("session-layer");
    expect(sessionLayer.dataset.sessionId).toBe("session-1");
    expect(sessionLayer.dataset.parked).toBe("false");

    fireEvent.click(screen.getByText("Agents"));

    expect(screen.getByTestId("route-content")).toBeTruthy();
    expect(screen.getByTestId("session-layer")).toBe(sessionLayer);
    expect(screen.getByTestId("session-layer").dataset.parked).toBe("true");
    expect(
      screen
        .getByTestId("session-layer")
        .closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("parked");

    fireEvent.click(screen.getByText("Session 1"));

    expect(screen.getByTestId("session-layer")).toBe(sessionLayer);
    expect(screen.getByTestId("session-layer").dataset.parked).toBe("false");
  });

  it("parks the session DOM under a full-frame project file route", () => {
    enableSessionDomLinger();
    renderNavigationLayoutWithSessionLinger();

    const sessionLayer = screen.getByTestId("session-layer");

    fireEvent.click(screen.getByText("File"));

    expect(screen.getByTestId("file-frame")).toBeTruthy();
    expect(screen.getByTestId("session-layer")).toBe(sessionLayer);
    expect(screen.getByTestId("session-layer").dataset.parked).toBe("true");
    expect(screen.queryByTestId("mobile-sidebar")).toBeNull();
    expect(
      screen
        .getByTestId("session-layer")
        .closest("[data-session-dom-linger]")
        ?.getAttribute("data-session-dom-linger"),
    ).toBe("parked");

    fireEvent.click(screen.getByText("Session 1"));

    expect(screen.getByTestId("session-layer")).toBe(sessionLayer);
    expect(screen.getByTestId("session-layer").dataset.parked).toBe("false");
  });

  it("expires the parked session DOM after the linger window", () => {
    enableSessionDomLinger();
    vi.useFakeTimers();
    renderNavigationLayoutWithSessionLinger();

    fireEvent.click(screen.getByText("Agents"));
    expect(screen.getByTestId("session-layer").dataset.parked).toBe("true");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.queryByTestId("session-layer")).toBeNull();
    expect(screen.getByTestId("route-content")).toBeTruthy();
  });

  it("does not park session DOM when session linger is disabled", () => {
    const sessionRenders: string[] = [];
    renderNavigationLayoutWithSessionLinger(
      "/projects/project-1/sessions/session-1",
      {
        onSessionRender: (parked, sessionId) => {
          sessionRenders.push(`${sessionId}:${parked ? "parked" : "active"}`);
        },
      },
    );

    fireEvent.click(screen.getByText("Agents"));

    expect(sessionRenders).not.toContain("session-1:parked");
    expect(screen.queryByTestId("session-layer")).toBeNull();
    expect(screen.getByTestId("route-content")).toBeTruthy();
  });

  it("does not park the old session when navigating directly to another session", () => {
    enableSessionDomLinger();
    renderNavigationLayoutWithSessionLinger();

    const firstSessionLayer = screen.getByTestId("session-layer");
    fireEvent.click(screen.getByText("Session 2"));

    const secondSessionLayer = screen.getByTestId("session-layer");
    expect(secondSessionLayer).not.toBe(firstSessionLayer);
    expect(secondSessionLayer.dataset.sessionId).toBe("session-2");
    expect(secondSessionLayer.dataset.parked).toBe("false");
  });

  it("retains one project glossary owner across same-project sessions", () => {
    renderNavigationLayoutWithSessionLinger();

    const glossaryProvider = screen.getByTestId("glossary-project-provider");
    expect(glossaryProvider.dataset.projectId).toBe("project-1");
    expect(glossaryProvider.dataset.enabled).toBe("true");

    fireEvent.click(screen.getByText("Session 2"));

    expect(screen.getByTestId("glossary-project-provider")).toBe(
      glossaryProvider,
    );
    expect(
      screen.getByTestId("glossary-project-provider").dataset.projectId,
    ).toBe("project-1");
  });
});
