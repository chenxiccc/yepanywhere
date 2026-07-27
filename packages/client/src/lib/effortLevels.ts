import type {
  EffortLevel,
  ModelInfo,
  ProviderInfo,
  ProviderName,
  ThinkingMode,
} from "@yep-anywhere/shared";

export interface EffortLevelOption {
  value: EffortLevel;
  label: string;
  description: string;
}

export type EffortLevelMessageKey =
  | "effortLevelLowLabel"
  | "effortLevelMediumLabel"
  | "effortLevelHighLabel"
  | "effortLevelExtraLabel"
  | "effortLevelExtraHighLabel"
  | "effortLevelMaxLabel"
  | "effortLevelLowDescription"
  | "effortLevelMediumDescription"
  | "effortLevelHighDescription"
  | "effortLevelExtraDescription"
  | "effortLevelExtraHighDescription"
  | "effortLevelMaxDescription";

export type EffortLevelTranslate = (key: EffortLevelMessageKey) => string;

export const EFFORT_LEVEL_ORDER: EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const GENERIC_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "max"];

const CODEX_EFFORT_LEVELS: EffortLevel[] = ["low", "medium", "high", "xhigh"];

const EFFORT_LEVEL_SET = new Set<string>(EFFORT_LEVEL_ORDER);

const DEFAULT_EFFORT_LEVEL_MESSAGES: Record<EffortLevelMessageKey, string> = {
  effortLevelLowLabel: "Low",
  effortLevelMediumLabel: "Medium",
  effortLevelHighLabel: "High",
  effortLevelExtraLabel: "Extra",
  effortLevelExtraHighLabel: "Extra High",
  effortLevelMaxLabel: "Max",
  effortLevelLowDescription: "Fastest responses",
  effortLevelMediumDescription: "Moderate reasoning",
  effortLevelHighDescription: "Deep reasoning",
  effortLevelExtraDescription: "For your hardest tasks",
  effortLevelExtraHighDescription: "Extra-high reasoning",
  effortLevelMaxDescription: "Maximum effort",
};

const defaultTranslateEffortLevel: EffortLevelTranslate = (key) =>
  DEFAULT_EFFORT_LEVEL_MESSAGES[key];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return typeof value === "string" && EFFORT_LEVEL_SET.has(value);
}

function getProviderName(
  provider?: ProviderInfo | ProviderName | null,
): ProviderName | undefined {
  if (!provider) return undefined;
  return typeof provider === "string" ? provider : provider.name;
}

function getModelInfo(
  provider?: ProviderInfo | ProviderName | null,
  model?: ModelInfo | string | null,
): ModelInfo | undefined {
  if (!model) return undefined;
  if (typeof model !== "string") return model;
  if (!provider || typeof provider === "string") return undefined;
  return provider.models?.find((candidate) => candidate.id === model);
}

function sortEffortLevels(levels: EffortLevel[]): EffortLevel[] {
  const seen = new Set<EffortLevel>();
  for (const level of levels) {
    seen.add(level);
  }
  return EFFORT_LEVEL_ORDER.filter((level) => seen.has(level));
}

function getModelSupportedEfforts(model?: ModelInfo): EffortLevel[] | null {
  const directLevels =
    model?.supportedEffortLevels?.filter(isEffortLevel) ?? [];
  if (directLevels.length > 0) {
    return sortEffortLevels(directLevels);
  }

  const reasoningLevels =
    model?.supportedReasoningEfforts
      ?.map((effort) => effort.reasoningEffort)
      .filter(isEffortLevel) ?? [];
  if (reasoningLevels.length > 0) {
    return sortEffortLevels(reasoningLevels);
  }

  return null;
}

function getFallbackEffortLevels(providerName?: ProviderName): EffortLevel[] {
  switch (providerName) {
    case "claude":
    case "claude-ollama":
      return EFFORT_LEVEL_ORDER;
    case "claude-gateway":
      return [];
    case "codex":
      return CODEX_EFFORT_LEVELS;
    default:
      return GENERIC_EFFORT_LEVELS;
  }
}

export function getEffortLevelLabel(
  level: EffortLevel,
  provider?: ProviderInfo | ProviderName | null,
  translate: EffortLevelTranslate = defaultTranslateEffortLevel,
): string {
  const providerName = getProviderName(provider);
  switch (level) {
    case "low":
      return translate("effortLevelLowLabel");
    case "medium":
      return translate("effortLevelMediumLabel");
    case "high":
      return translate("effortLevelHighLabel");
    case "xhigh":
      return providerName === "claude" ||
        providerName === "claude-gateway" ||
        providerName === "claude-ollama"
        ? translate("effortLevelExtraLabel")
        : translate("effortLevelExtraHighLabel");
    case "max":
      return translate("effortLevelMaxLabel");
  }
}

function getFallbackDescription(
  level: EffortLevel,
  provider?: ProviderInfo | ProviderName | null,
  translate: EffortLevelTranslate = defaultTranslateEffortLevel,
): string {
  const providerName = getProviderName(provider);
  switch (level) {
    case "low":
      return translate("effortLevelLowDescription");
    case "medium":
      return translate("effortLevelMediumDescription");
    case "high":
      return translate("effortLevelHighDescription");
    case "xhigh":
      return providerName === "claude" ||
        providerName === "claude-gateway" ||
        providerName === "claude-ollama"
        ? translate("effortLevelExtraDescription")
        : translate("effortLevelExtraHighDescription");
    case "max":
      return translate("effortLevelMaxDescription");
  }
}

function getModelDescription(
  model: ModelInfo | undefined,
  level: EffortLevel,
): string | undefined {
  return model?.supportedReasoningEfforts?.find(
    (effort) => effort.reasoningEffort === level,
  )?.description;
}

export function getEffortLevelOptions(params: {
  provider?: ProviderInfo | ProviderName | null;
  model?: ModelInfo | string | null;
  translate?: EffortLevelTranslate;
}): EffortLevelOption[] {
  const model = getModelInfo(params.provider, params.model);
  const levels =
    getModelSupportedEfforts(model) ??
    getFallbackEffortLevels(getProviderName(params.provider));

  return levels.map((level) => ({
    value: level,
    label: getEffortLevelLabel(level, params.provider, params.translate),
    description:
      getModelDescription(model, level) ??
      getFallbackDescription(level, params.provider, params.translate),
  }));
}

export const EFFORT_LEVEL_OPTIONS = getEffortLevelOptions({});

export function getFallbackEffortLevel(
  options: EffortLevelOption[],
): EffortLevel {
  return options.at(-1)?.value ?? "high";
}

export function resolveSupportedEffortLevel(
  effort: EffortLevel,
  options: EffortLevelOption[],
): EffortLevel {
  return options.some((option) => option.value === effort)
    ? effort
    : getFallbackEffortLevel(options);
}

export function getThinkingModeOptions(params: {
  provider?: ProviderInfo | ProviderName | null;
  model?: ModelInfo | string | null;
  effortOptions?: readonly EffortLevelOption[];
}): ThinkingMode[] {
  const model = getModelInfo(params.provider, params.model);
  if (
    getProviderName(params.provider) === "claude-gateway" &&
    model === undefined
  ) {
    return ["off"];
  }
  if (model?.supportsAdaptiveThinking === false) {
    return ["off"];
  }

  const modes: ThinkingMode[] = ["off", "auto"];
  const supportsEffort = model?.supportsEffort !== false;
  if (supportsEffort && (params.effortOptions?.length ?? 1) > 0) {
    modes.push("on");
  }
  return modes;
}

export function resolveSupportedThinkingMode(
  mode: ThinkingMode,
  options: readonly ThinkingMode[],
): ThinkingMode {
  if (options.includes(mode)) return mode;
  return options.includes("auto") ? "auto" : "off";
}

export function normalizeEffortLevelForProvider(
  effort: string | undefined,
  provider?: ProviderInfo | ProviderName | null,
): EffortLevel {
  const providerName = getProviderName(provider);
  if (effort === "max" && providerName === "codex") {
    return "xhigh";
  }
  return isEffortLevel(effort) ? effort : "high";
}
