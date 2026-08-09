import { describe, expect, it } from "vitest";
import { resolveInheritedForkModel } from "../../../src/sdk/providers/types.js";

describe("resolveInheritedForkModel", () => {
  it("preserves an explicit source selection", () => {
    expect(resolveInheritedForkModel("gpt-5.6-sol", "claude-opus-5")).toBe(
      "gpt-5.6-sol",
    );
  });

  it("pins default to the first provider-reported model", () => {
    expect(
      resolveInheritedForkModel(
        "default",
        undefined,
        "gpt-5.6-sol",
        "claude-opus-5",
      ),
    ).toBe("gpt-5.6-sol");
  });

  it("returns undefined when the source model is not yet known", () => {
    expect(resolveInheritedForkModel("default", undefined)).toBeUndefined();
  });
});
