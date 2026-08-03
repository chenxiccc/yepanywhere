// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../i18n";
import { invalidateLocalStorageValues } from "../../../lib/localStorageValue";
import { UI_KEYS } from "../../../lib/storageKeys";
import { AppearanceSettings } from "../AppearanceSettings";

function renderAppearanceSettings() {
  return render(
    <I18nProvider>
      <MemoryRouter>
        <AppearanceSettings />
      </MemoryRouter>
    </I18nProvider>,
  );
}

describe("AppearanceSettings", () => {
  afterEach(() => {
    cleanup();
    localStorage.clear();
    invalidateLocalStorageValues();
  });

  it("keeps style and delay in one row and valid delay edits select themed", () => {
    const { container } = renderAppearanceSettings();
    const row = container.querySelector(".tooltip-settings-actions");
    expect(row).toBeTruthy();
    expect(row?.querySelector(".tooltip-mode-selector")).toBeTruthy();
    expect(row?.querySelector('input[type="range"]')).toBeTruthy();
    expect(row?.querySelector('input[type="number"]')).toBeTruthy();

    const nativeButton = screen.getByRole("button", { name: "Native" });
    expect(nativeButton.classList.contains("active")).toBe(true);
    fireEvent.click(nativeButton);
    expect(localStorage.getItem(UI_KEYS.tooltipMode)).toBe("native");

    const number = screen.getByRole<HTMLInputElement>("spinbutton", {
      name: "Tooltip Style and Delay",
    });
    fireEvent.change(number, { target: { value: "" } });
    expect(localStorage.getItem(UI_KEYS.tooltipMode)).toBe("native");

    fireEvent.change(number, { target: { value: "80" } });
    expect(localStorage.getItem(UI_KEYS.tooltipMode)).toBe("themed");
    fireEvent.blur(number);
    expect(localStorage.getItem(UI_KEYS.tooltipDelayMs)).toBe("80");
  });

  it("shows UI size metrics and changes sidebar spacing", () => {
    renderAppearanceSettings();

    expect(screen.getByRole("button", { name: "Small 85%" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Default 100%" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Large 115%" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Larger 130%" })).toBeTruthy();

    const comfortable = screen.getByRole("button", { name: "Comfortable" });
    expect(comfortable.classList.contains("active")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Compact" }));
    expect(localStorage.getItem(UI_KEYS.sidebarSpacing)).toBe("compact");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-row-min-height",
      ),
    ).toBe("1.5rem");
  });

  it("places compact image galleries beside inline media and defaults them on", () => {
    const { container } = renderAppearanceSettings();
    const galleryToggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Compact Multi-Image Galleries",
    });
    const galleryRow = galleryToggle.closest("[data-settings-item]");

    expect(galleryToggle.checked).toBe(true);
    expect(
      galleryRow?.previousElementSibling?.getAttribute("data-settings-item"),
    ).toBe("expand-inline-media-by-default");

    fireEvent.click(galleryToggle);
    expect(galleryToggle.checked).toBe(false);
    expect(localStorage.getItem(UI_KEYS.compactMultiImageGalleries)).toBe(
      "false",
    );
    expect(container.textContent).toContain(
      "It opens automatically when inline media starts expanded",
    );
  });

  it("keeps wider Conversation activity previews default-off in Appearance", () => {
    renderAppearanceSettings();
    const toggle = screen.getByRole<HTMLInputElement>("checkbox", {
      name: "Wider activity previews",
    });

    expect(toggle.checked).toBe(false);
    expect(
      screen.getByText(
        "In Conversation view, move thinking to the right to make room for longer activity previews.",
      ),
    ).toBeTruthy();

    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(
      localStorage.getItem(UI_KEYS.widerConversationActivityPreviews),
    ).toBe("true");
  });
});
