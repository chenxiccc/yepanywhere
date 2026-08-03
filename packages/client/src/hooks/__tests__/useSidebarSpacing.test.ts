import { beforeEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import { initializeSidebarSpacing } from "../useSidebarSpacing";

describe("initializeSidebarSpacing", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-sidebar-spacing");
    document.documentElement.style.removeProperty("--sidebar-row-min-height");
  });

  it("defaults to comfortable spacing", () => {
    initializeSidebarSpacing();

    expect(document.documentElement.dataset.sidebarSpacing).toBe(
      "comfortable",
    );
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-row-min-height",
      ),
    ).toBe("34px");
  });

  it("restores compact spacing", () => {
    localStorage.setItem(UI_KEYS.sidebarSpacing, "compact");

    initializeSidebarSpacing();

    expect(document.documentElement.dataset.sidebarSpacing).toBe("compact");
    expect(
      document.documentElement.style.getPropertyValue(
        "--sidebar-row-min-height",
      ),
    ).toBe("1.5rem");
  });
});
