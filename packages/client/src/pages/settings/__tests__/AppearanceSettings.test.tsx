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

    const themedButton = screen.getByRole("button", { name: "Themed" });
    expect(themedButton.classList.contains("active")).toBe(true);
    const nativeButton = screen.getByRole("button", { name: "Native" });
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

  it("controls free UI size entry and compact sidebar metrics", () => {
    const { container } = renderAppearanceSettings();

    const slider = container.querySelector<HTMLInputElement>("#ui-font-scale");
    const number = container.querySelector<HTMLInputElement>(
      "#ui-font-scale-number",
    );
    expect(slider).toBeTruthy();
    expect(number).toBeTruthy();
    if (!slider || !number) throw new Error("UI size controls are missing");
    expect(slider.getAttribute("aria-label")).toBe("UI size");
    expect(number.getAttribute("aria-label")).toBe("UI size");
    expect(slider.min).toBe("85");
    expect(slider.max).toBe("130");
    expect(slider.step).toBe("5");
    expect(number.min).toBe("50");
    expect(number.max).toBe("300");
    expect(number.step).toBe("any");
    expect(
      Array.from(
        container.querySelectorAll<HTMLOptionElement>(
          "#ui-font-scale-presets option",
        ),
        (option) => option.value,
      ),
    ).toEqual(["85", "100", "115", "130"]);

    fireEvent.change(number, { target: { value: "93.5" } });
    fireEvent.blur(number);
    expect(localStorage.getItem(UI_KEYS.fontSize)).toBe("93.5");
    expect(document.documentElement.style.fontSize).toBe("93.5%");

    fireEvent.change(number, { target: { value: "25" } });
    fireEvent.blur(number);
    expect(localStorage.getItem(UI_KEYS.fontSize)).toBe("50");
    expect(number.value).toBe("50");
    expect(slider.value).toBe("85");

    fireEvent.change(number, { target: { value: "350" } });
    fireEvent.blur(number);
    expect(localStorage.getItem(UI_KEYS.fontSize)).toBe("300");
    expect(number.value).toBe("300");
    expect(slider.value).toBe("130");

    const comfortable = screen.getByText("Comfortable").closest("button");
    expect(comfortable).toBeTruthy();
    if (!comfortable) throw new Error("Comfortable spacing control is missing");
    expect(comfortable.classList.contains("active")).toBe(true);
    const compact = screen.getByText("Compact").closest("button");
    expect(compact).toBeTruthy();
    if (!compact) throw new Error("Compact spacing control is missing");
    fireEvent.click(compact);
    expect(localStorage.getItem(UI_KEYS.sidebarSpacing)).toBe("compact");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-row-min-height",
      ),
    ).toBe("calc(1.5rem + 1px)");
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
