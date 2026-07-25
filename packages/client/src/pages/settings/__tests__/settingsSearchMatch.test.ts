import { describe, expect, it } from "vitest";
import {
  settingsItemSlug,
  settingsSearchTokens,
  settingsTextMatches,
  splitSettingsMatchSegments,
} from "../settingsSearchMatch";

describe("settingsSearchTokens", () => {
  it("splits on whitespace and lowercases", () => {
    expect(settingsSearchTokens("  Font  SIZE ")).toEqual(["font", "size"]);
  });

  it("returns no tokens for blank input", () => {
    expect(settingsSearchTokens("   ")).toEqual([]);
  });
});

describe("settingsTextMatches", () => {
  it("matches case-insensitive substrings", () => {
    expect(settingsTextMatches("font", ["Output Font"])).toBe(true);
    expect(settingsTextMatches("FONT", ["output font"])).toBe(true);
    expect(settingsTextMatches("fonts", ["Output Font"])).toBe(false);
  });

  it("requires every token to match somewhere (AND across texts)", () => {
    const texts = ["Output Font", "Font family used for prose"];
    expect(settingsTextMatches("font prose", texts)).toBe(true);
    expect(settingsTextMatches("font mono", texts)).toBe(false);
  });

  it("matches nothing on an empty query or empty texts", () => {
    expect(settingsTextMatches("", ["Output Font"])).toBe(false);
    expect(settingsTextMatches("font", [undefined])).toBe(false);
  });
});

describe("splitSettingsMatchSegments", () => {
  it("marks a single occurrence preserving original casing", () => {
    expect(splitSettingsMatchSegments("Output Font", "font")).toEqual([
      { text: "Output ", match: false },
      { text: "Font", match: true },
    ]);
  });

  it("marks every occurrence of every token", () => {
    expect(splitSettingsMatchSegments("tab size and font size", "size")).toEqual([
      { text: "tab ", match: false },
      { text: "size", match: true },
      { text: " and font ", match: false },
      { text: "size", match: true },
    ]);
  });

  it("merges overlapping token ranges", () => {
    expect(splitSettingsMatchSegments("abcd", "abc bcd")).toEqual([
      { text: "abcd", match: true },
    ]);
  });

  it("returns one unmatched segment when nothing matches", () => {
    expect(splitSettingsMatchSegments("Theme", "font")).toEqual([
      { text: "Theme", match: false },
    ]);
  });
});

describe("settingsItemSlug", () => {
  it("slugs labels to kebab-case", () => {
    expect(settingsItemSlug("Output Font Size (px)")).toBe("output-font-size-px");
  });
});
