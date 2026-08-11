import { describe, expect, it } from "vitest";
import { getSessionHoverCardLeft } from "../SessionHoverCard";

describe("SessionHoverCard placement", () => {
  it("prefers the open space beyond the session row", () => {
    expect(
      getSessionHoverCardLeft({
        rowLeft: 0,
        rowRight: 280,
        cursorX: 120,
        cardWidth: 600,
        viewportWidth: 1920,
      }),
    ).toBe(288);
  });

  it("uses the left side when the right side is constrained", () => {
    expect(
      getSessionHoverCardLeft({
        rowLeft: 900,
        rowRight: 1100,
        cursorX: 1000,
        cardWidth: 500,
        viewportWidth: 1200,
      }),
    ).toBe(392);
  });

  it("falls back to a viewport-clamped cursor position", () => {
    expect(
      getSessionHoverCardLeft({
        rowLeft: 100,
        rowRight: 1100,
        cursorX: 300,
        cardWidth: 500,
        viewportWidth: 1200,
      }),
    ).toBe(314);
  });
});
