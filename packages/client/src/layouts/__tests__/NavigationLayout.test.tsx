import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";

const mocks = vi.hoisted(() => ({
  useRetainSidebarSessionFeeds: vi.fn(),
  Sidebar: vi.fn(({ isDesktop }: { isDesktop?: boolean }) => (
    <div data-testid={isDesktop ? "desktop-sidebar" : "mobile-sidebar"} />
  )),
  MobileTopNav: vi.fn(() => <div data-testid="mobile-top-nav" />),
}));

vi.mock("../../components/Sidebar", () => ({
  Sidebar: mocks.Sidebar,
}));

vi.mock("../../components/MobileTopNav", () => ({
  MobileTopNav: mocks.MobileTopNav,
}));

vi.mock("../../hooks/useSidebarSessionFeeds", () => ({
  useRetainSidebarSessionFeeds: mocks.useRetainSidebarSessionFeeds,
}));

import {
  NavigationLayout,
  SessionDomLingerRouteMarker,
} from "../NavigationLayout";

function renderNavigationLayout(path = "/agents") {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route element={<NavigationLayout />}>
          <Route path="/agents" element={<div data-testid="route-content" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

function renderNavigationLayoutWithSessionLinger(
  path = "/projects/project-1/sessions/session-1",
  options: {
    onSessionRender?: (parked: boolean, sessionId: string) => void;
  } = {},
) {
  render(
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
    </MemoryRouter>,
  );
}

function enableSessionDomLinger() {
  window.localStorage.setItem(UI_KEYS.sessionDomLinger, "true");
}

describe("NavigationLayout", () => {
  beforeEach(() => {
    mocks.useRetainSidebarSessionFeeds.mockClear();
    mocks.Sidebar.mockClear();
    window.localStorage.clear();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    window.localStorage.clear();
  });

  it("mounts sidebar session coverage from the app shell", () => {
    renderNavigationLayout();

    expect(screen.getByTestId("route-content")).toBeTruthy();
    expect(mocks.useRetainSidebarSessionFeeds).toHaveBeenCalledTimes(1);
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
});
