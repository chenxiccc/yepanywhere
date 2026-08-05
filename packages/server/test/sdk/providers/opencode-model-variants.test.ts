import { describe, expect, it } from "vitest";
import {
  getLocalGlmModelDescription,
  parseOpenCodeModelSelection,
  parseOpenCodeModelVariants,
  parseOpenCodeVerboseModels,
} from "../../../src/sdk/providers/opencode-models.js";

describe("OpenCode model helpers", () => {
  it("parses provider/model selections for message requests", () => {
    expect(parseOpenCodeModelSelection(undefined)).toBeUndefined();
    expect(parseOpenCodeModelSelection("default")).toBeUndefined();
    expect(parseOpenCodeModelSelection("auto")).toBeUndefined();
    expect(
      parseOpenCodeModelSelection("github-copilot/claude-opus-4.8"),
    ).toEqual({
      providerID: "github-copilot",
      modelID: "claude-opus-4.8",
    });
    expect(parseOpenCodeModelSelection("local-glm/Qwen/Qwen3.6-27B")).toEqual({
      providerID: "local-glm",
      modelID: "Qwen/Qwen3.6-27B",
    });
    expect(() => parseOpenCodeModelSelection("claude-opus-4.8")).toThrow(
      'OpenCode model must use provider/model format, got "claude-opus-4.8"',
    );
    expect(() => parseOpenCodeModelSelection("github-copilot/")).toThrow(
      'OpenCode model must use provider/model format, got "github-copilot/"',
    );
  });

  it("describes local GLM launch commands", () => {
    expect(getLocalGlmModelDescription("local-glm/Qwen/Qwen3.6-27B")).toContain(
      "pixi run vllm serve Qwen/Qwen3.6-27B-FP8",
    );
    expect(getLocalGlmModelDescription("local-glm/custom/model")).toContain(
      "pixi run vllm serve custom/model --served-model-name custom/model",
    );
  });

  it("extracts effort variant levels per model from verbose output", () => {
    const verbose = [
      "github-copilot/claude-opus-4.8",
      "{",
      '  "id": "claude-opus-4.8",',
      '  "providerID": "github-copilot",',
      '  "variants": {',
      '    "low": { "effort": "low" },',
      '    "medium": { "effort": "medium" },',
      '    "high": { "effort": "high" },',
      '    "xhigh": { "effort": "xhigh" },',
      '    "max": { "effort": "max" }',
      "  }",
      "}",
      "opencode/big-pickle",
      "{",
      '  "id": "big-pickle",',
      '  "providerID": "opencode"',
      "}",
    ].join("\n");
    const map = parseOpenCodeModelVariants(verbose);
    expect(map.get("github-copilot/claude-opus-4.8")).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    // No variants -> not in the map (no effort selector advertised).
    expect(map.has("opencode/big-pickle")).toBe(false);
  });

  it("returns an empty map for empty/garbage output", () => {
    expect(parseOpenCodeModelVariants("").size).toBe(0);
    expect(parseOpenCodeModelVariants("not json\njust text\n").size).toBe(0);
  });

  it("lists the advertised models from verbose output in listing order", () => {
    const verbose = [
      "github-copilot/claude-opus-4.8",
      "{",
      '  "id": "claude-opus-4.8",',
      '  "providerID": "github-copilot",',
      '  "variants": { "high": { "effort": "high" } }',
      "}",
      "opencode/big-pickle",
      "{",
      '  "id": "big-pickle",',
      '  "providerID": "opencode"',
      "}",
      "local-glm/Qwen/Qwen3.6-27B",
      "{",
      '  "id": "Qwen/Qwen3.6-27B",',
      '  "providerID": "local-glm"',
      "}",
    ].join("\n");
    const { ids, variants } = parseOpenCodeVerboseModels(verbose);
    expect(ids).toEqual([
      "github-copilot/claude-opus-4.8",
      "opencode/big-pickle",
      "local-glm/Qwen/Qwen3.6-27B",
    ]);
    expect(variants.get("github-copilot/claude-opus-4.8")).toEqual(["high"]);
    expect(parseOpenCodeVerboseModels("").ids).toEqual([]);
  });
});
