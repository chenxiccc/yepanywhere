import { describe, expect, it } from "vitest";
import { chooseUserPromptActionLayout } from "../useUserPromptActionPacking";

const common = {
  actionGap: 4,
  actionSize: 34,
  availableInlineSize: 800,
  inlineEndInset: 4,
};

describe("chooseUserPromptActionLayout", () => {
  it("puts three actions in one row beside a short prompt", () => {
    expect(
      chooseUserPromptActionLayout({
        ...common,
        actionCount: 3,
        measurePromptBlockSize: () => 24,
      }),
    ).toEqual({ columns: 3, rows: 1 });
  });

  it("keeps a tall prompt beside the narrow one-column rail", () => {
    expect(
      chooseUserPromptActionLayout({
        ...common,
        actionCount: 3,
        measurePromptBlockSize: () => 120,
      }),
    ).toEqual({ columns: 1, rows: 3 });
  });

  it("uses a two-column grid when it fits inside the prompt height", () => {
    expect(
      chooseUserPromptActionLayout({
        ...common,
        actionCount: 4,
        measurePromptBlockSize: () => 80,
      }),
    ).toEqual({ columns: 2, rows: 2 });
  });

  it("uses the smallest total block when every wider shape wraps", () => {
    expect(
      chooseUserPromptActionLayout({
        ...common,
        actionCount: 3,
        measurePromptBlockSize: (width) => (width >= 700 ? 24 : 48),
      }),
    ).toEqual({ columns: 3, rows: 1 });
  });
});
