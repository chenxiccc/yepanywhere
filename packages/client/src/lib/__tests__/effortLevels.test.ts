import type { ProviderInfo } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  getEffortLevelLabel,
  getEffortLevelOptions,
  getThinkingModeOptions,
  normalizeEffortLevelForProvider,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../effortLevels";

const claudeProvider: ProviderInfo = {
  name: "claude",
  displayName: "Claude",
  installed: true,
  authenticated: true,
  enabled: true,
};

const codexProvider: ProviderInfo = {
  name: "codex",
  displayName: "Codex",
  installed: true,
  authenticated: true,
  enabled: true,
};

const claudeGatewayProvider: ProviderInfo = {
  name: "claude-gateway",
  displayName: "Claude Gateway",
  installed: true,
  authenticated: true,
  enabled: true,
};

describe("effort level options", () => {
  it("defaults Claude to all five SDK effort levels", () => {
    expect(getEffortLevelOptions({ provider: claudeProvider })).toEqual([
      expect.objectContaining({ value: "low", label: "Low" }),
      expect.objectContaining({ value: "medium", label: "Medium" }),
      expect.objectContaining({ value: "high", label: "High" }),
      expect.objectContaining({ value: "xhigh", label: "Extra" }),
      expect.objectContaining({ value: "max", label: "Max" }),
    ]);
  });

  it("uses provider/model reported levels when present", () => {
    expect(
      getEffortLevelOptions({
        provider: claudeProvider,
        model: {
          id: "sonnet",
          name: "Sonnet",
          supportedEffortLevels: ["low", "medium", "high", "xhigh"],
        },
      }).map((option) => option.value),
    ).toEqual(["low", "medium", "high", "xhigh"]);
  });

  it("does not invent gateway effort levels without model metadata", () => {
    expect(
      getEffortLevelOptions({
        provider: claudeGatewayProvider,
        model: "unlisted-model",
      }),
    ).toEqual([]);
    expect(
      getThinkingModeOptions({
        provider: claudeGatewayProvider,
        model: "unlisted-model",
      }),
    ).toEqual(["off"]);
  });

  it("uses Codex reasoning metadata and does not invent max", () => {
    const options = getEffortLevelOptions({
      provider: codexProvider,
      model: {
        id: "gpt-5.4",
        name: "GPT-5.4",
        supportedReasoningEfforts: [
          { reasoningEffort: "low" },
          { reasoningEffort: "medium" },
          { reasoningEffort: "high" },
          { reasoningEffort: "xhigh" },
        ],
      },
    });

    expect(options.map((option) => option.value)).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
    ]);
    expect(getEffortLevelLabel("xhigh", codexProvider)).toBe("Extra High");
  });

  it("normalizes legacy Codex max to xhigh for display and selection", () => {
    const options = getEffortLevelOptions({ provider: codexProvider });

    expect(normalizeEffortLevelForProvider("max", codexProvider)).toBe("xhigh");
    expect(resolveSupportedEffortLevel("max", options)).toBe("xhigh");
  });

  it("gates thinking modes from model adaptive and effort flags", () => {
    expect(
      getThinkingModeOptions({
        provider: claudeProvider,
        model: {
          id: "adaptive-only",
          name: "Adaptive only",
          supportsAdaptiveThinking: true,
          supportsEffort: false,
        },
      }),
    ).toEqual(["off", "auto"]);

    expect(
      getThinkingModeOptions({
        provider: claudeProvider,
        model: {
          id: "no-thinking",
          name: "No thinking",
          supportsAdaptiveThinking: false,
        },
      }),
    ).toEqual(["off"]);
  });

  it("normalizes unsupported thinking modes to the closest available mode", () => {
    expect(resolveSupportedThinkingMode("on", ["off", "auto"])).toBe("auto");
    expect(resolveSupportedThinkingMode("auto", ["off"])).toBe("off");
  });
});
