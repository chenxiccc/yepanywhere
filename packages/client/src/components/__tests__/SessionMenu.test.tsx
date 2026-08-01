// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { SessionMenu, type SessionMenuProps } from "../SessionMenu";
import styles from "../SessionMenu.module.css";

afterEach(() => {
  cleanup();
});

function renderMenu(props: Partial<SessionMenuProps> = {}) {
  return render(
    <I18nProvider>
      <SessionMenu
        sessionId="session-1"
        projectId="project-1"
        isStarred={false}
        isArchived={false}
        onToggleStar={vi.fn()}
        onToggleArchive={vi.fn()}
        onRename={vi.fn()}
        {...props}
      />
    </I18nProvider>,
  );
}

describe("SessionMenu CSS module contracts", () => {
  it("keeps the caller and global hooks alongside module classes", () => {
    const { container } = renderMenu({
      className: "session-list-item__menu",
    });
    const wrapper = container.firstElementChild as HTMLElement;
    const trigger = screen.getByRole("button", { name: "Session options" });

    expect(wrapper.classList.contains(styles.wrapper ?? "")).toBe(true);
    expect(wrapper.classList.contains("session-menu-wrapper")).toBe(true);
    expect(wrapper.classList.contains("session-list-item__menu")).toBe(true);
    expect(wrapper.classList.contains("is-open")).toBe(false);
    expect(trigger.classList.contains(styles.trigger ?? "")).toBe(true);
    expect(trigger.classList.contains("session-menu-trigger")).toBe(true);

    fireEvent.click(trigger);

    expect(wrapper.classList.contains("is-open")).toBe(true);
    const dropdown = screen.getByRole("button", { name: "Star" })
      .parentElement as HTMLElement;
    expect(dropdown.classList.contains(styles.dropdown ?? "")).toBe(true);
    expect(dropdown.classList.contains("session-menu-dropdown")).toBe(false);
  });

  it("styles the terminate variant in a fixed-position portal", () => {
    const { container } = renderMenu({
      processId: "process-1",
      onTerminate: vi.fn(),
      useFixedPositioning: true,
    });
    const trigger = screen.getByRole("button", { name: "Session options" });

    fireEvent.click(trigger);

    const terminateButton = screen.getByRole("button", { name: "Terminate" });
    const dropdown = terminateButton.parentElement as HTMLElement;
    expect(container.contains(dropdown)).toBe(false);
    expect(document.body.contains(dropdown)).toBe(true);
    expect(dropdown.classList.contains(styles.dropdown ?? "")).toBe(true);
    expect(dropdown.style.position).toBe("fixed");
    expect(
      terminateButton.classList.contains(styles.terminateButton ?? ""),
    ).toBe(true);
    expect(terminateButton.classList.contains("terminate-button")).toBe(false);
  });
});
