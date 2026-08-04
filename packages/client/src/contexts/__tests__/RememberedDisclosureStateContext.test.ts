import { describe, expect, it } from "vitest";
import { createRememberedDisclosureStateRegistry } from "../RememberedDisclosureStateContext";

describe("remembered disclosure state registry", () => {
  it("stores only states that differ from their default", () => {
    const registry = createRememberedDisclosureStateRegistry();

    expect(registry.read("tool-a", "media-a", false)).toEqual({
      expanded: false,
      overridden: false,
    });
    expect(registry.size).toBe(0);

    registry.write("tool-a", "media-a", false, true);
    expect(registry.read("tool-a", "media-a", false)).toEqual({
      expanded: true,
      overridden: true,
    });
    expect(registry.size).toBe(1);

    registry.write("tool-a", "media-a", false, false);
    expect(registry.size).toBe(0);
  });

  it("drops an override that becomes equal to a new default", () => {
    const registry = createRememberedDisclosureStateRegistry();
    registry.write("tool-a", "media-a", false, true);

    expect(registry.read("tool-a", "media-a", true)).toEqual({
      expanded: true,
      overridden: false,
    });
    expect(registry.size).toBe(0);
  });

  it("prunes overrides whose owning render item is no longer loaded", () => {
    const registry = createRememberedDisclosureStateRegistry();
    registry.write("tool-a", "media-a", false, true);
    registry.write("tool-b", "media-b", true, false);

    registry.pruneOwners(new Set(["tool-b"]));

    expect(registry.size).toBe(1);
    expect(registry.read("tool-b", "media-b", true)).toEqual({
      expanded: false,
      overridden: true,
    });
    expect(registry.read("tool-a", "media-a", false)).toEqual({
      expanded: false,
      overridden: false,
    });
  });
});
