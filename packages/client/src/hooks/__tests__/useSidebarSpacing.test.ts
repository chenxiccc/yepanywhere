import { beforeEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import { initializeSidebarSpacing } from "../useSidebarSpacing";

describe("initializeSidebarSpacing", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-sidebar-spacing");
    document.documentElement.style.removeProperty("--sidebar-row-min-height");
    document.documentElement.style.removeProperty(
      "--sidebar-actions-padding-top",
    );
    document.documentElement.style.removeProperty(
      "--sidebar-sessions-padding-top",
    );
    document.documentElement.style.removeProperty(
      "--sidebar-navigation-inline-spacing",
    );
    document.documentElement.style.removeProperty("--sidebar-header-padding");
    document.documentElement.style.removeProperty(
      "--sidebar-navigation-font-size",
    );
    document.documentElement.style.removeProperty(
      "--sidebar-header-justify-content",
    );
    document.documentElement.style.removeProperty("--sidebar-brand-display");
  });

  it("defaults to comfortable spacing", () => {
    initializeSidebarSpacing();

    expect(document.documentElement.dataset.sidebarSpacing).toBe("comfortable");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-row-min-height",
      ),
    ).toBe("34px");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-navigation-inline-spacing",
      ),
    ).toBe("0.75rem");
  });

  it("restores compact spacing", () => {
    localStorage.setItem(UI_KEYS.sidebarSpacing, "compact");
    document.documentElement.style.setProperty(
      "--sidebar-navigation-font-size",
      "var(--font-size-base)",
    );
    document.documentElement.style.setProperty(
      "--sidebar-header-justify-content",
      "flex-end",
    );
    document.documentElement.style.setProperty(
      "--sidebar-brand-display",
      "none",
    );

    initializeSidebarSpacing();

    expect(document.documentElement.dataset.sidebarSpacing).toBe("compact");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-row-min-height",
      ),
    ).toBe("calc(1.5rem + 1px)");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-navigation-inline-spacing",
      ),
    ).toBe("0.5rem");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-header-padding",
      ),
    ).toBe("0.25rem 0.5rem");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-navigation-font-size",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-brand-display",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-header-justify-content",
      ),
    ).toBe("");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-actions-padding-top",
      ),
    ).toBe("1px");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-sessions-padding-top",
      ),
    ).toBe("0");
  });
});
