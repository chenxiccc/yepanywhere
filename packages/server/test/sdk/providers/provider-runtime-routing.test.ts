import { describe, expect, it } from "vitest";
import { selectCodexRuntimeBackend } from "../../../src/sdk/providers/index.js";

describe("selectCodexRuntimeBackend", () => {
  it("uses the setting for both new sessions and first-time resumes", () => {
    expect(
      selectCodexRuntimeBackend({
        hasCodexNativeRuntime: false,
        hasSharedProviderRuntime: false,
        codexNativeHostEnabled: true,
      }),
    ).toBe("codex-native-host");
    expect(
      selectCodexRuntimeBackend({
        resumeSessionId: "resume-me",
        hasCodexNativeRuntime: false,
        hasSharedProviderRuntime: false,
        codexNativeHostEnabled: true,
      }),
    ).toBe("codex-native-host");
    expect(
      selectCodexRuntimeBackend({
        resumeSessionId: "resume-me",
        hasCodexNativeRuntime: false,
        hasSharedProviderRuntime: false,
        codexNativeHostEnabled: false,
      }),
    ).toBe("shared-provider-host");
  });

  it("keeps resumed sessions on the backend that launched them", () => {
    expect(
      selectCodexRuntimeBackend({
        resumeSessionId: "native",
        hasCodexNativeRuntime: true,
        hasSharedProviderRuntime: false,
        codexNativeHostEnabled: false,
      }),
    ).toBe("codex-native-host");
    expect(
      selectCodexRuntimeBackend({
        resumeSessionId: "shared",
        hasCodexNativeRuntime: false,
        hasSharedProviderRuntime: true,
        codexNativeHostEnabled: true,
      }),
    ).toBe("shared-provider-host");
  });
});
