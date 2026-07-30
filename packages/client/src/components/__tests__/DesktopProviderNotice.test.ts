import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { hasDesktopProviderRuntime } from "../DesktopProviderNotice";

function provider(
  name: "claude" | "codex",
  values: Partial<ProviderInfo>,
): ProviderInfo {
  return {
    name,
    displayName: name,
    installed: false,
    authenticated: false,
    enabled: false,
    ...values,
  };
}

describe("desktop provider notice detection", () => {
  it("accepts a coarse application signal without requiring authentication", () => {
    expect(
      hasDesktopProviderRuntime([
        provider("codex", {
          applicationDetected: true,
          authenticated: false,
        }),
      ]),
    ).toBe(true);
  });

  it("uses installed as the fallback for older provider payloads", () => {
    expect(
      hasDesktopProviderRuntime([provider("claude", { installed: true })]),
    ).toBe(true);
  });

  it("does not count the bundled provider SDK when detection is explicitly false", () => {
    expect(
      hasDesktopProviderRuntime([
        provider("claude", {
          installed: true,
          applicationDetected: false,
        }),
      ]),
    ).toBe(false);
  });
});
