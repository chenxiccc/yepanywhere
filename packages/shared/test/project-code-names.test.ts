import { describe, expect, it } from "vitest";
import {
  allocateProjectCodeName,
  normalizeProjectCodeName,
} from "../src/project-code-names.js";

describe("project code names", () => {
  it("extends once before walking later letters and falling back to a number", () => {
    const reserved = [
      "abc",
      "abd",
      "abe",
      "abf",
      "acd",
      "ace",
      "acf",
      "ade",
      "adf",
      "aef",
    ];

    expect(allocateProjectCodeName("abcdef", [])).toBe("abc");
    expect(allocateProjectCodeName("abcdef", ["abc"])).toBe("abcd");
    expect(allocateProjectCodeName("abcdef", ["abc", "abcd"])).toBe("abd");
    expect(allocateProjectCodeName("abcdef", [...reserved, "abcd"])).toBe(
      "ab2",
    );
  });

  it("treats prefixes of another project's full name as collisions", () => {
    expect(allocateProjectCodeName("abcde", [], ["abcd"])).toBe("abd");
    expect(allocateProjectCodeName("abcde", ["abc"], ["abcd"])).toBe("abd");
  });

  it("normalizes automatic Latin characters and compares reservations case-insensitively", () => {
    expect(allocateProjectCodeName("Éclair app", [])).toBe("ecl");
    expect(allocateProjectCodeName("Alpha", ["ALP"])).toBe("alph");
  });

  it("handles short and non-Latin project names predictably", () => {
    expect(allocateProjectCodeName("Go", [])).toBe("go");
    expect(allocateProjectCodeName("東京", [])).toBe("prj");
    expect(allocateProjectCodeName("東京", ["PRJ"])).toBe("pr2");
  });

  it("accepts only the approved manual character set", () => {
    expect(normalizeProjectCodeName("  My_app-2 ")).toBe("My_app-2");
    expect(normalizeProjectCodeName("twelve_chars")).toBe("twelve_chars");
    expect(() => normalizeProjectCodeName("two words")).toThrow(
      "letters, numbers, underscores, and hyphens",
    );
  });
});
