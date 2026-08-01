import {
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  PROMPT_SUGGESTION_MODES,
  type EffortLevel,
  type ModelInfo,
  type PromptSuggestionMode,
  type RecapMode,
  type ThinkingMode,
  type ThinkingOption,
} from "@yep-anywhere/shared";
import { isEffortLevel } from "./effortLevels";

export const RECAP_MODE_ORDER: readonly RecapMode[] = [
  "off",
  "side-session",
  "fork",
];
export const PROMPT_SUGGESTION_MODE_ORDER: readonly PromptSuggestionMode[] = [
  ...PROMPT_SUGGESTION_MODES,
];

export function toThinkingOption(
  mode: ThinkingMode,
  effort: EffortLevel,
): ThinkingOption {
  if (mode === "off") return "off";
  if (mode === "auto") return "auto";
  return `on:${effort}`;
}

export function parseThinkingOption(option: ThinkingOption): {
  mode: ThinkingMode;
  effort: EffortLevel;
} {
  if (option === "off") return { mode: "off", effort: "high" };
  if (option === "auto") return { mode: "auto", effort: "high" };
  const effort = option.startsWith("on:") ? option.slice(3) : option;
  return {
    mode: "on",
    effort: isEffortLevel(effort) ? effort : "high",
  };
}

export function providerSupportsRecapMode(
  provider:
    | {
        supportsRecaps?: boolean;
        supportsNativeRecaps?: boolean;
      }
    | null
    | undefined,
  mode: RecapMode,
): boolean {
  if (mode === "off") return true;
  if (mode === "native") return false;
  return provider?.supportsRecaps === true;
}

export function getPreferredRecapMode(
  _provider:
    | {
        supportsRecaps?: boolean;
        supportsNativeRecaps?: boolean;
      }
    | null
    | undefined,
  defaults?: { recapMode?: RecapMode } | null,
): RecapMode {
  if (defaults?.recapMode && RECAP_MODE_ORDER.includes(defaults.recapMode)) {
    return defaults.recapMode;
  }
  return "off";
}

export function resolveRecapMode(
  provider:
    | {
        supportsRecaps?: boolean;
        supportsNativeRecaps?: boolean;
      }
    | null
    | undefined,
  preferredMode: RecapMode,
): RecapMode {
  return providerSupportsRecapMode(provider, preferredMode)
    ? preferredMode
    : "off";
}

export function providerSupportsPromptSuggestionMode(
  provider: { supportsNativePromptSuggestions?: boolean } | null | undefined,
  mode: PromptSuggestionMode,
): boolean {
  if (mode === "off") return true;
  return provider?.supportsNativePromptSuggestions === true;
}

export function getPreferredPromptSuggestionMode(
  defaults?: { promptSuggestionMode?: PromptSuggestionMode } | null,
): PromptSuggestionMode {
  return defaults?.promptSuggestionMode &&
    PROMPT_SUGGESTION_MODE_ORDER.includes(defaults.promptSuggestionMode)
    ? defaults.promptSuggestionMode
    : "off";
}

export function resolvePromptSuggestionMode(
  provider: { supportsNativePromptSuggestions?: boolean } | null | undefined,
  preferredMode: PromptSuggestionMode,
): PromptSuggestionMode {
  return providerSupportsPromptSuggestionMode(provider, preferredMode)
    ? preferredMode
    : "off";
}

export function getDefaultHelperSideModel(
  models: ModelInfo[],
  defaults?: { helperSideModel?: string } | null,
): string {
  const defaultModel = defaults?.helperSideModel;
  if (
    defaultModel &&
    (defaultModel === HELPER_SIDE_MODEL_CHEAPEST ||
      defaultModel === HELPER_SIDE_MODEL_SAME_AS_MAIN ||
      models.some((model) => model.id === defaultModel))
  ) {
    return defaultModel;
  }
  return HELPER_SIDE_MODEL_CHEAPEST;
}
