import { describe, expect, it } from "vitest";
import {
  normalizeProviderCatalogFamilies,
  providerCatalogFamily,
} from "../../src/sessions/provider-catalog-family.js";

describe("provider catalog families", () => {
  it.each([
    ["claude", "claude"],
    ["claude-gateway", "claude"],
    ["claude-ollama", "claude"],
    ["codex", "codex"],
    ["codex-oss", "codex"],
    ["gemini", "gemini"],
    ["gemini-acp", "gemini"],
    ["grok", "grok"],
    ["opencode", "opencode"],
    ["pi", "pi"],
  ] as const)("maps %s to %s", (provider, family) => {
    expect(providerCatalogFamily(provider)).toBe(family);
  });

  it("filters, deduplicates, and orders persisted values", () => {
    expect(
      normalizeProviderCatalogFamilies(["pi", "invalid", "codex", "pi", null]),
    ).toEqual(["codex", "pi"]);
  });
});
