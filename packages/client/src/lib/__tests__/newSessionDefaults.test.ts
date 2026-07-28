import { describe, expect, it } from "vitest";
import {
  getPreferredModelId,
  getPreferredProviderModelId,
} from "../newSessionDefaults";

describe("getPreferredModelId", () => {
  const models = [
    { id: "latest", name: "Latest" },
    { id: "previous", name: "Previous" },
  ];

  it("uses the first model when no preference is saved", () => {
    expect(getPreferredModelId(models)).toBe("latest");
  });

  it("keeps a saved exact id when the current catalog omits it", () => {
    expect(getPreferredModelId(models, "unlisted")).toBe("unlisted");
  });

  it("uses only models advertised by Claude Gateway", () => {
    expect(
      getPreferredProviderModelId("claude-gateway", models, "gpt-5.5"),
    ).toBe("latest");
    expect(
      getPreferredProviderModelId("claude-gateway", [], "gpt-5.5"),
    ).toBeNull();
  });
});
