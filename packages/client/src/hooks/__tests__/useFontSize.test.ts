import { beforeEach, describe, expect, it } from "vitest";
import { UI_KEYS } from "../../lib/storageKeys";
import { initializeFontSize } from "../useFontSize";

describe("initializeFontSize", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.fontSize = "";
  });

  it("keeps the former Large preset as the default", () => {
    initializeFontSize();

    expect(document.documentElement.style.fontSize).toBe("115%");
  });

  it("maps legacy presets onto their numeric percentages", () => {
    localStorage.setItem(UI_KEYS.fontSize, "small");

    initializeFontSize();

    expect(document.documentElement.style.fontSize).toBe("85%");
  });

  it("restores free numeric values and clamps unsafe extremes", () => {
    localStorage.setItem(UI_KEYS.fontSize, "93.5");
    initializeFontSize();
    expect(document.documentElement.style.fontSize).toBe("93.5%");

    localStorage.setItem(UI_KEYS.fontSize, "900");
    initializeFontSize();
    expect(document.documentElement.style.fontSize).toBe("300%");
  });
});
