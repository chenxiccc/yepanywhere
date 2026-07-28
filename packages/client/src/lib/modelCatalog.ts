import type { ModelInfo, ProviderName } from "@yep-anywhere/shared";
import { providerRequiresAdvertisedModel } from "./newSessionDefaults";

/**
 * Keep a saved or live model choice visible even when it is absent from the
 * server's current opt-in catalog. The provider still receives the exact id.
 */
export function withVisibleModelSelection(
  models: readonly ModelInfo[],
  selectedModelId: string | null | undefined,
  unavailableDescription: string,
): ModelInfo[] {
  if (
    !selectedModelId ||
    models.some((model) => model.id === selectedModelId)
  ) {
    return [...models];
  }

  return [
    ...models,
    {
      id: selectedModelId,
      name: selectedModelId,
      description: unavailableDescription,
      catalogGroup: "additional",
    },
  ];
}

export function withProviderVisibleModelSelection(
  providerName: ProviderName | null | undefined,
  models: readonly ModelInfo[],
  selectedModelId: string | null | undefined,
  unavailableDescription: string,
): ModelInfo[] {
  if (providerRequiresAdvertisedModel(providerName)) {
    return [...models];
  }
  return withVisibleModelSelection(
    models,
    selectedModelId,
    unavailableDescription,
  );
}

export function startsAdditionalModelGroup(
  models: readonly ModelInfo[],
  index: number,
): boolean {
  return (
    models[index]?.catalogGroup === "additional" &&
    models[index - 1]?.catalogGroup !== "additional"
  );
}
