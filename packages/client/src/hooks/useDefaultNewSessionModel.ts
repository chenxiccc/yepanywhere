import { type ProviderName, resolveModel } from "@yep-anywhere/shared";
import { useMemo } from "react";
import {
  getPreferredProviderModelId,
  getProviderSessionDefaults,
} from "../lib/newSessionDefaults";
import { getModelSetting } from "./useModelSettings";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "./useProviders";
import { useServerSettings } from "./useServerSettings";

export interface DefaultNewSessionModel {
  provider: ProviderName;
  modelId: string | null;
}

/**
 * The provider + model a brand-new session would launch with right now,
 * resolved with the same seeding the New Session form applies (saved
 * new-session defaults, else the default provider and its preferred model).
 * Returns null until providers/settings load or when no provider is available.
 */
export function useDefaultNewSessionModel(): DefaultNewSessionModel | null {
  const { providers, loading: providersLoading } = useProviders();
  const { settings, isLoading: settingsLoading } = useServerSettings();

  return useMemo(() => {
    if (providersLoading || settingsLoading || providers.length === 0) {
      return null;
    }
    const availableNames = new Set(
      getAvailableProviders(providers).map((p) => p.name),
    );
    const savedDefaults = settings?.newSessionDefaults;
    const savedProviderName =
      savedDefaults?.provider && availableNames.has(savedDefaults.provider)
        ? savedDefaults.provider
        : null;
    const provider =
      providers.find((p) => p.name === savedProviderName) ??
      getDefaultProvider(providers);
    if (!provider) return null;

    const providerDefaults = getProviderSessionDefaults(
      savedDefaults,
      provider.name,
      {
        model:
          provider.name === "claude"
            ? resolveModel(getModelSetting())
            : undefined,
      },
    );
    return {
      provider: provider.name,
      modelId: getPreferredProviderModelId(
        provider.name,
        provider.models ?? [],
        providerDefaults.model,
      ),
    };
  }, [providers, providersLoading, settings, settingsLoading]);
}
