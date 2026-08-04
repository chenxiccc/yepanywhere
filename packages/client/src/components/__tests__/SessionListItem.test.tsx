// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { DEFAULT_HOVERCARD_SHOW_DELAY_MS } from "../../hooks/useHoverCardAppearance";
import { clearTooltipWarmth } from "../../hooks/useTooltipAppearance";
import { I18nProvider } from "../../i18n";
import { activityBus } from "../../lib/activityBus";
import { UI_KEYS } from "../../lib/storageKeys";
import "../../../test/pointerEventShim";
import { SessionListItem } from "../SessionListItem";

const mockWindowOpen = vi.fn();
const originalClipboard = navigator.clipboard;

function LocationProbe() {
  const location = useLocation();
  return (
    <output aria-label="location">
      {location.pathname}
      {location.search}
    </output>
  );
}

describe("SessionListItem links", () => {
  beforeEach(() => {
    clearTooltipWarmth();
    localStorage.clear();
    mockWindowOpen.mockReset();
    vi.stubGlobal("open", mockWindowOpen);
  });

  afterEach(() => {
    cleanup();
    clearTooltipWarmth();
    localStorage.clear();
    vi.useRealTimers();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: originalClipboard,
    });
    vi.unstubAllGlobals();
  });

  function renderItem(onNavigate = vi.fn()) {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Build logs"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );
    return {
      link: screen.getByRole("link", { name: /Build logs/ }),
      onNavigate,
    };
  }

  it("opens the session in a new window on middle click", () => {
    const { link, onNavigate } = renderItem();

    fireEvent.mouseDown(link, { button: 1 });
    link.dispatchEvent(
      new MouseEvent("auxclick", {
        bubbles: true,
        cancelable: true,
        button: 1,
      }),
    );

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/session-1",
      "_blank",
      "noopener",
    );
  });

  it("opens a new window on modified clicks without closing the current view", () => {
    const { link, onNavigate } = renderItem();

    fireEvent.click(link, { ctrlKey: true });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/session-1",
      "_blank",
      "noopener",
    );
  });

  it("labels /btw aside sessions separately from their truncated title text", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              parentSessionId="source-1"
              parentSessionKind="btw-aside"
              title="/btw check the side path"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("/btw")).toBeTruthy();
    expect(screen.getByText("check the side path")).toBeTruthy();
  });

  it("does not label an ordinary parent-linked Clone as /btw", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="clone-1"
              projectId="project-1"
              title="Clone: Main session"
              parentSessionId="source-1"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.queryByText("/btw")).toBeNull();
    expect(screen.getByText("Clone: Main session")).toBeTruthy();
  });

  it("keeps an explicitly typed /btw aside recognizable after rename", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="Renamed side investigation"
              parentSessionId="parent-1"
              parentSessionKind="btw-aside"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("/btw")).toBeTruthy();
    expect(screen.getByText("Renamed side investigation")).toBeTruthy();
  });

  it("opens the parent /btw view when the aside badge is clicked", () => {
    const onNavigate = vi.fn();

    render(
      <I18nProvider>
        <MemoryRouter
          initialEntries={["/remote/test/projects/project-1/sessions/aside-1"]}
        >
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="/btw check the side path"
              parentSessionId="parent-1"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
          <LocationProbe />
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("/btw"));

    expect(onNavigate).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("location").textContent).toBe(
      "/remote/test/projects/project-1/sessions/parent-1?btw=aside-1",
    );
  });

  it("opens the parent /btw view in a new window on modified badge clicks", () => {
    const onNavigate = vi.fn();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="aside-1"
              projectId="project-1"
              title="/btw check the side path"
              parentSessionId="parent-1"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByText("/btw"), { ctrlKey: true });

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/parent-1?btw=aside-1",
      "_blank",
      "noopener",
    );
  });

  it("copies the initial prompt from the session menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="failed-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Full initial prompt that should be recoverable"
              hasCustomTitle
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("button", { name: "Copy prompt" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "Full initial prompt that should be recoverable",
      );
    });
  });

  it("opens the session in a new tab from the session menu", () => {
    const onNavigate = vi.fn();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Menu new tab"
              provider="claude"
              mode="compact"
              onNavigate={onNavigate}
              basePath="/remote/test"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("button", { name: "Open in new tab" }));

    expect(onNavigate).not.toHaveBeenCalled();
    expect(mockWindowOpen).toHaveBeenCalledWith(
      "/remote/test/projects/project-1/sessions/session-1",
      "_blank",
      "noopener",
    );
  });

  it("attaches the recoverable title to the visible title owner", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Original first turn"
              hasCustomTitle
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const link = screen.getByRole("link", { name: /Custom title/ });
    expect(link.getAttribute("title")).toBeNull();
    expect(screen.getByText("Custom title").getAttribute("title")).toBe(
      "Custom title",
    );
  });

  it("shows a card-mode thinking dot when requested for active rows", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Active row"
              activity="in-turn"
              mode="card"
              showActivityIndicator
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const title = screen.getByRole("link", { name: "Active row" }).querySelector(
      "strong",
    );
    expect(title?.firstElementChild?.firstElementChild).not.toBeNull();
  });

  it("leaves card-mode activity hidden unless requested", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Active row"
              activity="in-turn"
              mode="card"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const title = screen.getByRole("link", { name: "Active row" }).querySelector(
      "strong",
    );
    expect(title?.children).toHaveLength(1);
  });

  it("uses custom titles for session hover previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Custom title"
              fullTitle="Original first turn"
              initialPrompt="Original first turn"
              hasCustomTitle
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Custom title/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });

    // The prompt block is the hover card's first child; assert on the rendered
    // text rather than a class name the owning module now scopes.
    const hoverCard = screen.getByRole("tooltip");
    expect(hoverCard.firstElementChild?.textContent).toBe("Custom title");
    expect(hoverCard.textContent).not.toContain("Original first turn");
  });

  it("delays session hover previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Delayed hover"
              initialPrompt="Delayed hover prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Delayed hover/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS - 1);
    });
    expect(screen.queryByText("Delayed hover prompt")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Delayed hover prompt")).toBeTruthy();
  });

  it("ignores touch compatibility mouse events for session hover previews", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Touch navigation"
              initialPrompt="Touch navigation prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Touch navigation/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "touch", clientX: 20 });
    fireEvent.mouseEnter(item!, { clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });

    expect(screen.queryByText("Touch navigation prompt")).toBeNull();
  });

  it("preserves the stored hover-card delay in native tooltip mode", () => {
    vi.useFakeTimers();
    localStorage.setItem(UI_KEYS.tooltipMode, "native");
    localStorage.setItem(UI_KEYS.sessionHoverCardShowDelayMs, "300");

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Native delay"
              initialPrompt="Native delay prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Native delay/ })
      .closest("li");
    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => vi.advanceTimersByTime(299));
    expect(screen.queryByText("Native delay prompt")).toBeNull();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Native delay prompt")).toBeTruthy();
  });

  it("keeps a session hover preview open while the pointer is over the card", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Selectable hover"
              initialPrompt="Selectable hover prompt"
              lastAgentText="Selectable recap text"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Selectable hover/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });

    const hoverCard = screen.getByRole("tooltip");
    expect(hoverCard).toBeTruthy();
    expect(screen.getByText("Selectable recap text")).toBeTruthy();

    fireEvent.pointerLeave(item!, {
      pointerType: "mouse",
      relatedTarget: hoverCard,
    });
    expect(screen.getByText("Selectable recap text")).toBeTruthy();

    fireEvent.mouseLeave(hoverCard);
    expect(screen.queryByText("Selectable recap text")).toBeNull();
  });

  it("switches immediately between session previews after the first opens", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="First session"
              initialPrompt="First session prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
            <SessionListItem
              sessionId="session-2"
              projectId="project-1"
              title="Second session"
              initialPrompt="Second session prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-2" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const firstItem = screen
      .getByRole("link", { name: /First session/ })
      .closest("li");
    const secondItem = screen
      .getByRole("link", { name: /Second session/ })
      .closest("li");
    expect(firstItem).toBeTruthy();
    expect(secondItem).toBeTruthy();

    fireEvent.pointerEnter(firstItem!, {
      pointerType: "mouse",
      clientX: 20,
    });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS);
    });
    expect(screen.getByText("First session prompt")).toBeTruthy();

    fireEvent.pointerLeave(firstItem!, {
      pointerType: "mouse",
      relatedTarget: secondItem,
    });
    fireEvent.pointerEnter(secondItem!, {
      pointerType: "mouse",
      clientX: 20,
    });
    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(screen.queryByText("First session prompt")).toBeNull();
    expect(screen.getByText("Second session prompt")).toBeTruthy();
  });

  it("keeps session hover previews open during unrelated scrolls", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <div data-testid="transcript-scroll" />
          <div data-testid="sidebar-scroll">
            <ul>
              <SessionListItem
                sessionId="session-1"
                projectId="project-1"
                title="Scoped scroll"
                initialPrompt="Scoped scroll prompt"
                provider="claude"
                status={{ owner: "self", processId: "pid-1" }}
                mode="compact"
              />
            </ul>
          </div>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen
      .getByRole("link", { name: /Scoped scroll/ })
      .closest("li");
    expect(item).toBeTruthy();

    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByText("Scoped scroll prompt")).toBeTruthy();

    fireEvent.scroll(screen.getByTestId("transcript-scroll"));
    expect(screen.getByText("Scoped scroll prompt")).toBeTruthy();

    fireEvent.scroll(screen.getByTestId("sidebar-scroll"));
    expect(screen.queryByText("Scoped scroll prompt")).toBeNull();
  });

  it("does not use a native title tooltip for session menu options", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Menu title"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByLabelText("Session options").getAttribute("title")).toBe(
      null,
    );
  });

  it("does not show a hover card while the session menu is open", () => {
    vi.useFakeTimers();

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Menu open"
              initialPrompt="Menu open prompt"
              provider="claude"
              status={{ owner: "self", processId: "pid-1" }}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen.getByRole("link", { name: /Menu open/ }).closest("li");
    expect(item).toBeTruthy();

    act(() => {
      fireEvent.click(screen.getByLabelText("Session options"));
    });
    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });
    act(() => {
      vi.advanceTimersByTime(DEFAULT_HOVERCARD_SHOW_DELAY_MS + 50);
    });

    expect(screen.queryByText("Menu open prompt")).toBeNull();
  });

  it("emits a local metadata event after starring from the menu", async () => {
    const updateSpy = vi
      .spyOn(api, "updateSessionMetadata")
      .mockResolvedValue({ updated: true });
    const emitSpy = vi.spyOn(activityBus, "emitLocal");

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Star me"
              provider="claude"
              isStarred={false}
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    fireEvent.click(screen.getByLabelText("Session options"));
    fireEvent.click(screen.getByRole("button", { name: "Star" }));

    await waitFor(() => {
      expect(updateSpy).toHaveBeenCalledWith("session-1", { starred: true });
      expect(emitSpy).toHaveBeenCalledWith(
        "session-metadata-changed",
        expect.objectContaining({
          type: "session-metadata-changed",
          sessionId: "session-1",
          starred: true,
        }),
      );
    });

    updateSpy.mockRestore();
    emitSpy.mockRestore();
  });

  it("refreshes the preview on hover, before the show delay elapses", () => {
    vi.useFakeTimers();
    const refreshSpy = vi
      .spyOn(api, "refreshSessionPreview")
      .mockResolvedValue(undefined as never);

    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-1"
              projectId="project-1"
              title="Idle row"
              initialPrompt="Idle row prompt"
              provider="claude"
              mode="compact"
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    const item = screen.getByRole("link", { name: /Idle row/ }).closest("li");
    fireEvent.pointerEnter(item!, { pointerType: "mouse", clientX: 20 });

    // Fires immediately on hover, not gated behind the show delay.
    expect(refreshSpy).toHaveBeenCalledWith("project-1", "session-1");

    refreshSpy.mockRestore();
  });

  it("shows provider child work inside its parent session row", () => {
    render(
      <I18nProvider>
        <MemoryRouter>
          <ul>
            <SessionListItem
              sessionId="session-parent"
              projectId="project-1"
              title="Parent session"
              provider="claude"
              mode="card"
              providerChildren={[
                {
                  id: "child-native-1",
                  parentSessionId: "session-parent",
                  title: "Audit the child-session API",
                  agentType: "general-purpose",
                  updatedAt: "2026-07-19T12:00:00.000Z",
                },
              ]}
            />
          </ul>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(screen.getByText("Audit the child-session API")).toBeTruthy();
    expect(screen.getByText("general-purpose")).toBeTruthy();
  });
});
