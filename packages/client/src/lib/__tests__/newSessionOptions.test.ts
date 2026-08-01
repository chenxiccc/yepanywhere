import {
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  type ModelInfo,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  getDefaultHelperSideModel,
  getPreferredPromptSuggestionMode,
  getPreferredRecapMode,
  parseThinkingOption,
  providerSupportsPromptSuggestionMode,
  providerSupportsRecapMode,
  resolvePromptSuggestionMode,
  resolveRecapMode,
  toThinkingOption,
} from "../newSessionOptions";

const models: ModelInfo[] = [
  {
    id: "model-a",
    name: "Model A",
  },
  {
    id: "model-b",
    name: "Model B",
  },
];

describe("new session option defaults", () => {
  it("maps thinking mode and effort to provider launch options", () => {
    expect(toThinkingOption("off", "high")).toBe("off");
    expect(toThinkingOption("auto", "high")).toBe("auto");
    expect(toThinkingOption("on", "medium")).toBe("on:medium");
    expect(parseThinkingOption("off")).toEqual({
      mode: "off",
      effort: "high",
    });
    expect(parseThinkingOption("auto")).toEqual({
      mode: "auto",
      effort: "high",
    });
    expect(parseThinkingOption("on:max")).toEqual({
      mode: "on",
      effort: "max",
    });
    expect(parseThinkingOption("xhigh")).toEqual({
      mode: "on",
      effort: "xhigh",
    });
  });

  it("keeps saved recap defaults only when the mode is offered", () => {
    expect(getPreferredRecapMode(null, { recapMode: "fork" })).toBe("fork");
    expect(getPreferredRecapMode(null, { recapMode: "native" })).toBe("off");
    expect(providerSupportsRecapMode({ supportsRecaps: true }, "fork")).toBe(
      true,
    );
    expect(providerSupportsRecapMode({ supportsRecaps: false }, "fork")).toBe(
      false,
    );
    expect(resolveRecapMode({ supportsRecaps: false }, "side-session")).toBe(
      "off",
    );
  });

  it("resolves prompt suggestion modes from provider support", () => {
    expect(getPreferredPromptSuggestionMode({ promptSuggestionMode: "native" }))
      .toBe("native");
    expect(providerSupportsPromptSuggestionMode(null, "off")).toBe(true);
    expect(providerSupportsPromptSuggestionMode(null, "native")).toBe(false);
    expect(
      resolvePromptSuggestionMode(
        { supportsNativePromptSuggestions: true },
        "native",
      ),
    ).toBe("native");
    expect(resolvePromptSuggestionMode(null, "native")).toBe("off");
  });

  it("accepts helper side model sentinels and available model ids", () => {
    expect(
      getDefaultHelperSideModel(models, {
        helperSideModel: HELPER_SIDE_MODEL_SAME_AS_MAIN,
      }),
    ).toBe(HELPER_SIDE_MODEL_SAME_AS_MAIN);
    expect(getDefaultHelperSideModel(models, { helperSideModel: "model-b" }))
      .toBe("model-b");
    expect(getDefaultHelperSideModel(models, { helperSideModel: "missing" }))
      .toBe(HELPER_SIDE_MODEL_CHEAPEST);
  });
});
