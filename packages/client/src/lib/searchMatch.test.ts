import { describe, expect, it } from "vitest";
import { findTextMatch } from "./searchMatch";

describe("searchMatch", () => {
  it("finds a case-insensitive match without changing its text", () => {
    expect(findTextMatch("before Needle after", "needle")).toEqual({
      start: 7,
      end: 13,
      prefix: "before ",
      text: "Needle",
      suffix: " after",
    });
  });
});
