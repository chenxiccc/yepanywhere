import type { ModelInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  startsAdditionalModelGroup,
  withProviderVisibleModelSelection,
  withVisibleModelSelection,
} from "../modelCatalog";

describe("model catalog helpers", () => {
  const primary: ModelInfo[] = [{ id: "latest", name: "Latest" }];

  it("does not change membership for a visible selection", () => {
    expect(withVisibleModelSelection(primary, "latest", "Unavailable")).toEqual(
      primary,
    );
  });

  it("keeps a missing saved or live selection visible and separate", () => {
    expect(
      withVisibleModelSelection(primary, "previous", "Unavailable"),
    ).toEqual([
      { id: "latest", name: "Latest" },
      {
        id: "previous",
        name: "previous",
        description: "Unavailable",
        catalogGroup: "additional",
      },
    ]);
  });

  it("does not add an unadvertised Claude Gateway selection", () => {
    expect(
      withProviderVisibleModelSelection(
        "claude-gateway",
        primary,
        "gpt-5.5",
        "Unavailable",
      ),
    ).toEqual(primary);
  });

  it("identifies only the first additional row as a group boundary", () => {
    const models: ModelInfo[] = [
      ...primary,
      { id: "old-1", name: "Old 1", catalogGroup: "additional" },
      { id: "old-2", name: "Old 2", catalogGroup: "additional" },
    ];

    expect(startsAdditionalModelGroup(models, 0)).toBe(false);
    expect(startsAdditionalModelGroup(models, 1)).toBe(true);
    expect(startsAdditionalModelGroup(models, 2)).toBe(false);
  });
});
