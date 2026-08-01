import { describe, expect, it } from "vitest";
import { isBtwAsideSession } from "../btwAsideSessions";

describe("isBtwAsideSession", () => {
  it("uses the explicit relationship for renamed asides", () => {
    expect(
      isBtwAsideSession({
        parentSessionKind: "btw-aside",
        title: "Renamed side investigation",
      }),
    ).toBe(true);
  });

  it("falls back to the generated title on older servers", () => {
    expect(isBtwAsideSession({ title: "/btw inspect the side path" })).toBe(
      true,
    );
  });

  it("does not infer /btw from ordinary Clone or Fork titles", () => {
    expect(isBtwAsideSession({ title: "Clone: Main session" })).toBe(false);
    expect(isBtwAsideSession({ title: "Fork: Main session" })).toBe(false);
  });
});
