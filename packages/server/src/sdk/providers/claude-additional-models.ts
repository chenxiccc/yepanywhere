import type {
  ClaudeAdditionalModelSelection,
  ModelInfo,
} from "@yep-anywhere/shared";

const CLAUDE_ADDITIONAL_MODEL_REGISTRY = [
  {
    id: "claude-opus-4-8",
    name: "Opus 4.8",
    description: "Previous Opus generation · full 1M context",
    contextWindow: 1_000_000,
    catalogGroup: "additional",
  },
  {
    id: "claude-opus-4-6",
    name: "Opus 4.6",
    description: "Previous Opus generation · 200K default context",
    contextWindow: 200_000,
    catalogGroup: "additional",
  },
  {
    id: "claude-sonnet-4-6",
    name: "Sonnet 4.6",
    description: "Previous Sonnet generation · 200K default context",
    contextWindow: 200_000,
    catalogGroup: "additional",
  },
] as const satisfies readonly ModelInfo[];

export function getClaudeAdditionalModelOptions(): ModelInfo[] {
  return CLAUDE_ADDITIONAL_MODEL_REGISTRY.map((model) => ({ ...model }));
}

export function projectClaudeAdditionalModels(
  primaryModels: readonly ModelInfo[],
  selections: readonly ClaudeAdditionalModelSelection[] | undefined,
): ModelInfo[] {
  if (!selections || selections.length === 0) {
    return [...primaryModels];
  }

  const registryById = new Map<string, ModelInfo>(
    CLAUDE_ADDITIONAL_MODEL_REGISTRY.map((model) => [model.id, model]),
  );
  const visibleIds = new Set(primaryModels.map((model) => model.id));
  const projected = [...primaryModels];

  for (const selection of selections) {
    if (visibleIds.has(selection.id)) continue;

    const registered = registryById.get(selection.id);
    projected.push(
      registered
        ? { ...registered }
        : {
            id: selection.id,
            name: selection.label,
            description:
              selection.origin === "registry"
                ? "Previously enabled model · no longer maintained by this server"
                : "Custom model ID",
            catalogGroup: "additional",
          },
    );
    visibleIds.add(selection.id);
  }

  return projected;
}

export function getClaudeModelCatalogCacheKey(
  selections: readonly ClaudeAdditionalModelSelection[] | undefined,
): string {
  return JSON.stringify(selections ?? []);
}
