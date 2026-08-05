import {
  DEFAULT_RECAP_AFTER_SECONDS,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  HELPER_SIDE_MODEL_CHEAPEST,
  HELPER_SIDE_MODEL_SAME_AS_MAIN,
  PROMPT_CACHE_KEEPALIVE_MODES,
  PROMPT_SUGGESTION_MODES,
  type EffortLevel,
  type NewSessionDefaults,
  resolveModel,
  type ModelInfo,
  type PermissionMode,
  type PromptCacheKeepaliveMode,
  type PromptCacheKeepaliveSettings,
  type PromptSuggestionMode,
  type ProviderInfo,
  type ProviderName,
  type ProviderSessionDefaults,
  type RecapMode,
  type ThinkingMode,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";
import {
  MODEL_OPTIONS,
  getModelSetting,
  useModelSettings,
} from "../../hooks/useModelSettings";
import {
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../../lib/effortLevels";
import {
  getProviderSessionDefaults,
  withProviderSessionDefaults,
} from "../../lib/newSessionDefaults";
import { providerSupportsLocalSessionSandbox } from "../../lib/providerCapabilities";
import { serverHasAvailableSessionSandbox } from "../../lib/sessionSandboxAvailability";
import { getRecapModeDescription } from "../../lib/recapModes";
import { getPermissionModeOptions } from "../../lib/permissionModes";
import {
  getAvailableProviders,
  getDefaultProvider,
  useProviders,
} from "../../hooks/useProviders";
import { useCallback, useMemo } from "react";
import { useForkSummaryAutoOpen } from "../../hooks/useForkSummaryAutoOpen";
import { useProviderSubscriptionUsage } from "../../hooks/useProviderSubscriptionUsage";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  ClaudeAutoCompactPercentOverrideControl,
  YaCompactContextEarlyControl,
} from "./compactSettingsControls";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";
import { useToastContext } from "../../contexts/ToastContext";
import {
  FilterDropdown,
  type FilterOption,
} from "../../components/FilterDropdown";
import { ProviderBadge } from "../../components/ProviderBadge";
import { ModelSubscriptionUsage } from "../../components/ModelSubscriptionUsage";
import { RecapAfterSecondsControl } from "../../components/RecapAfterSecondsControl";
import {
  ShowThinkingControls,
  ThinkingControlsPanel,
} from "../../components/ThinkingControls";

const RECAP_MODE_ORDER: RecapMode[] = ["off", "side-session", "fork"];
const PROMPT_SUGGESTION_MODE_ORDER: PromptSuggestionMode[] = [
  ...PROMPT_SUGGESTION_MODES,
];
const PROMPT_CACHE_KEEPALIVE_MODE_ORDER: PromptCacheKeepaliveMode[] = [
  ...PROMPT_CACHE_KEEPALIVE_MODES,
];

function getPreferredProvider(
  providers: ProviderInfo[],
  preferredProvider?: ProviderName,
): ProviderInfo | null {
  const availableProviders = getAvailableProviders(providers);
  if (preferredProvider) {
    const matching = availableProviders.find(
      (p) => p.name === preferredProvider,
    );
    if (matching) return matching;
  }
  return getDefaultProvider(providers);
}

function getPreferredModel(
  models: ModelInfo[],
  preferredModel?: string,
): string | null {
  if (preferredModel) {
    const matchingModel = models.find((m) => m.id === preferredModel);
    if (matchingModel) return matchingModel.id;
  }
  return (
    models.find((m) => m.isDefault)?.id ??
    models.find((m) => m.id === "default")?.id ??
    models[0]?.id ??
    null
  );
}

function getPreferredProviderModel(
  providerName: ProviderName,
  models: ModelInfo[],
  defaults?: NewSessionDefaults | null,
): string | null {
  const legacyClaudeFallbackModel =
    providerName === "claude" ? resolveModel(getModelSetting()) : undefined;
  const providerDefaults = getProviderSessionDefaults(defaults, providerName, {
    model: legacyClaudeFallbackModel,
  });

  return getPreferredModel(models, providerDefaults.model);
}

function getPreferredRecapMode(
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

function getPreferredPromptSuggestionMode(
  defaults?: { promptSuggestionMode?: PromptSuggestionMode } | null,
): PromptSuggestionMode {
  if (
    defaults?.promptSuggestionMode &&
    PROMPT_SUGGESTION_MODE_ORDER.includes(defaults.promptSuggestionMode)
  ) {
    return defaults.promptSuggestionMode;
  }
  return "off";
}

function getDefaultHelperSideModel(
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

function getProviderPromptCacheKeepaliveSetting(
  provider: ProviderInfo | null | undefined,
  settings: PromptCacheKeepaliveSettings | null | undefined,
): {
  mode: PromptCacheKeepaliveMode;
  inactivityMinutes: number;
} {
  const capability = provider?.promptCacheKeepalive;
  const saved =
    provider && settings?.providers
      ? settings.providers[provider.name]
      : undefined;
  return {
    mode: saved?.mode ?? capability?.defaultMode ?? "off",
    inactivityMinutes:
      saved?.inactivityMinutes ??
      capability?.defaultInactivityMinutes ??
      DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  };
}

function normalizeKeepaliveMinutes(value: number): number | null {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Math.min(1440, Math.max(1, Math.round(value)));
}

export function ModelSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("modelSettingsTitle"));
  const { showToast } = useToastContext();
  const {
    model,
    setModel,
    effortLevel,
    setEffortLevel,
    thinkingMode,
    setThinkingMode,
    showThinking,
    setShowThinking,
  } = useModelSettings();
  const { providers, loading: providersLoading } = useProviders();
  const [forkSummaryAutoOpen, setForkSummaryAutoOpen] =
    useForkSummaryAutoOpen();
  const {
    settings,
    isLoading: settingsLoading,
    updateSetting,
  } = useServerSettings();
  const { version } = useVersion();
  const supportsSessionSandboxing = serverHasAvailableSessionSandbox(version);

  const availableProviders = getAvailableProviders(providers);
  const savedDefaults = settings?.newSessionDefaults;

  // Header undo across both state sources: the client-scoped model prefs
  // (useModelSettings setters) and the server-side new-session defaults.
  const undoState = useMemo(
    () =>
      settings
        ? {
            model,
            effortLevel,
            thinkingMode,
            showThinking,
            newSessionDefaults: settings.newSessionDefaults ?? {},
            promptCacheKeepalive: settings.promptCacheKeepalive ?? {},
          }
        : null,
    [settings, model, effortLevel, thinkingMode, showThinking],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setModel(snapshot.model);
      setEffortLevel(snapshot.effortLevel);
      setThinkingMode(snapshot.thinkingMode);
      setShowThinking(snapshot.showThinking);
      void updateSetting("newSessionDefaults", snapshot.newSessionDefaults);
      void updateSetting("promptCacheKeepalive", snapshot.promptCacheKeepalive);
    },
    [setModel, setEffortLevel, setThinkingMode, setShowThinking, updateSetting],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);
  const selectedProvider =
    getPreferredProvider(providers, savedDefaults?.provider) ?? null;
  const { usage: subscriptionUsage } = useProviderSubscriptionUsage(
    selectedProvider?.name,
  );
  const canConfigureSessionSandbox =
    supportsSessionSandboxing &&
    providerSupportsLocalSessionSandbox(selectedProvider?.name);
  const selectedModels = selectedProvider?.models ?? [];
  const selectedModel =
    selectedProvider === null
      ? null
      : getPreferredProviderModel(
          selectedProvider.name,
          selectedModels,
          savedDefaults,
        );
  const selectedProviderDefaults = selectedProvider
    ? getProviderSessionDefaults(savedDefaults, selectedProvider.name, {
        model:
          selectedProvider.name === "claude"
            ? resolveModel(getModelSetting())
            : undefined,
        thinkingMode,
        effortLevel,
      })
    : ({} satisfies ProviderSessionDefaults);
  const helperSelectableModels = selectedModels;
  const savedRecapMode = getPreferredRecapMode(selectedProvider, savedDefaults);
  const selectedRecapMode =
    canConfigureSessionSandbox &&
    savedDefaults?.sandboxLevel === "project-write" &&
    savedRecapMode === "side-session"
      ? "off"
      : savedRecapMode;
  const selectedRecapAfterSeconds = normalizeRecapAfterSeconds(
    savedDefaults?.recapAfterSeconds ?? DEFAULT_RECAP_AFTER_SECONDS,
  );
  const selectedPromptSuggestionMode =
    getPreferredPromptSuggestionMode(savedDefaults);
  const selectedPromptCacheKeepalive = getProviderPromptCacheKeepaliveSetting(
    selectedProvider,
    settings?.promptCacheKeepalive,
  );
  const selectedHelperSideModel = getDefaultHelperSideModel(
    helperSelectableModels,
    selectedProviderDefaults,
  );
  const selectedModelInfo =
    selectedModels.find((modelInfo) => modelInfo.id === selectedModel) ?? null;
  // Per-model "compact context early" threshold (task 029): a percent of the
  // selected model's context window. 0 = off, stored as the model's key being
  // absent from clientDefaults.compactAtContextPercent. A local draft tracks
  // the slider during a drag; commit-on-release writes the whole map, so
  // dragging a model down to 0 drops its key and turns it off.
  const storedCompactPercent =
    (selectedModel
      ? settings?.clientDefaults?.compactAtContextPercent?.[selectedModel]
      : undefined) ?? 0;
  const forceYaOrchestratedCompaction =
    settings?.clientDefaults?.forceYaOrchestratedCompaction === true;
  const showCompactThreshold =
    (selectedProvider?.name.startsWith("claude") === true ||
      selectedProvider?.supportsNativeCompactThreshold === true) &&
    selectedModelInfo != null &&
    // The live trigger keys by the running process model, which is always a
    // concrete id (e.g. "opus") — never the "default" sentinel. Offering a
    // threshold for "default" would only persist a key that can never fire.
    selectedModel !== "default";
  const claudeProviderForCompact = availableProviders.find(
    (p) => p.name === "claude",
  );
  const showClaudeAutoCompactMirror =
    claudeProviderForCompact?.supportsLaunchCompactPercentOverride === true;
  const effortOptions = getEffortLevelOptions({
    provider: selectedProvider,
    model: selectedModelInfo,
    translate: t,
  });
  const effectiveEffortLevel = resolveSupportedEffortLevel(
    selectedProviderDefaults.effortLevel ?? "high",
    effortOptions,
  );
  const thinkingModeOptions = getThinkingModeOptions({
    provider: selectedProvider,
    model: selectedModelInfo,
    effortOptions,
  });
  const effectiveThinkingMode = resolveSupportedThinkingMode(
    selectedProviderDefaults.thinkingMode ?? "off",
    thinkingModeOptions,
  );
  const permissionModeOptions = getPermissionModeOptions({
    model: selectedModelInfo,
  });
  const effectiveDefaultPermissionMode = permissionModeOptions.includes(
    savedDefaults?.permissionMode ?? "default",
  )
    ? (savedDefaults?.permissionMode ?? "default")
    : "default";
  const modeLabels: Record<PermissionMode, string> = {
    default: t("modeDefaultLabel"),
    acceptEdits: t("modeAcceptEditsLabel"),
    plan: t("modePlanLabel"),
    bypassPermissions: t("modeBypassPermissionsLabel"),
    auto: t("modeAutoLabel"),
  };
  const modeDescriptions: Record<PermissionMode, string> = {
    default: t("modeDefaultDescription"),
    acceptEdits: t("modeAcceptEditsDescription"),
    plan: t("modePlanDescription"),
    bypassPermissions: t("modeBypassPermissionsDescription"),
    auto: t("modeAutoDescription"),
  };
  const recapModeLabels: Record<RecapMode, string> = {
    off: t("recapModeOff"),
    native: t("recapModeNative"),
    "side-session": t("recapModeSideSession"),
    fork: t("recapModeFork"),
  };
  const promptSuggestionModeLabels: Record<PromptSuggestionMode, string> = {
    off: t("promptSuggestionModeOff"),
    native: t("promptSuggestionModeNative"),
  };
  const promptSuggestionModeDescriptions: Record<PromptSuggestionMode, string> =
    {
      off: t("promptSuggestionModeOffDescription"),
      native: t("promptSuggestionModeNativeDescription"),
    };
  const promptCacheKeepaliveModeLabels: Record<
    PromptCacheKeepaliveMode,
    string
  > = {
    auto: t("promptCacheKeepaliveModeAuto"),
    off: t("promptCacheKeepaliveModeOff"),
  };
  const promptCacheKeepaliveModeDescriptions: Record<
    PromptCacheKeepaliveMode,
    string
  > = {
    auto: t("promptCacheKeepaliveModeAutoDescription", {
      minutes: selectedPromptCacheKeepalive.inactivityMinutes,
    }),
    off: t("promptCacheKeepaliveModeOffDescription"),
  };
  const recapAfterSecondsInlineLabels: Record<RecapMode, string> = {
    off: t("recapAfterSecondsLabel"),
    native: t("recapAfterSecondsInlineNative"),
    "side-session": t("recapAfterSecondsInlineSideSession"),
    fork: t("recapAfterSecondsInlineFork"),
  };
  const supportsPermissionMode =
    selectedProvider?.supportsPermissionMode ?? true;
  const supportsThinkingToggle =
    selectedProvider?.supportsThinkingToggle ?? true;
  const showThinkingControls =
    supportsThinkingToggle &&
    thinkingModeOptions.some((option) => option !== "off");
  const availableRecapModes = RECAP_MODE_ORDER;
  const availablePromptSuggestionModes = PROMPT_SUGGESTION_MODE_ORDER;
  const showHelperSideModel = selectedRecapMode === "side-session";
  const showPromptCacheKeepalive =
    selectedProvider?.promptCacheKeepalive?.supportsNoContextPollutionNudge ===
    true;
  const modelOptions: FilterOption<string>[] = selectedModels.map((option) => {
    const label = option.size
      ? `${option.name} (${(option.size / (1024 * 1024 * 1024)).toFixed(1)} GB)`
      : option.name;
    const descriptionParts: string[] = [];
    if (option.parameterSize) descriptionParts.push(option.parameterSize);
    if (option.contextWindow) {
      descriptionParts.push(`${Math.round(option.contextWindow / 1024)}K ctx`);
    }
    if (option.parentModel) descriptionParts.push(option.parentModel);
    if (option.quantizationLevel) {
      descriptionParts.push(option.quantizationLevel);
    }
    return {
      value: option.id,
      label,
      description: option.description ?? descriptionParts.join(" · "),
      // Same provider → route → model badge as the session header/tooltip, so
      // the route (e.g. pi's "copilot") is visible alongside the model name.
      icon: selectedProvider ? (
        <ProviderBadge provider={selectedProvider.name} model={option.id} />
      ) : undefined,
      meta: (
        <ModelSubscriptionUsage usage={subscriptionUsage} modelId={option.id} />
      ),
    };
  });
  const helperSideModelOptions: FilterOption<string>[] = [
    {
      value: HELPER_SIDE_MODEL_CHEAPEST,
      label: t("helperSideModelCheapest"),
    },
    {
      value: HELPER_SIDE_MODEL_SAME_AS_MAIN,
      label: t("helperSideModelSameAsMain"),
      description: selectedModel ?? undefined,
    },
    ...helperSelectableModels.map((option) => ({
      value: option.id,
      label: option.name,
      description: option.description,
    })),
  ];

  const updateNewSessionDefaults = async (
    updates: NewSessionDefaults,
  ): Promise<void> => {
    try {
      const nextDefaults: NewSessionDefaults = {
        ...savedDefaults,
        ...updates,
      };
      if (!supportsSessionSandboxing) {
        delete nextDefaults.sandboxLevel;
      }
      await updateSetting("newSessionDefaults", nextDefaults);
      showToast(t("newSessionDefaultsSaved"), "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("newSessionDefaultsSaveError"),
        "error",
      );
    }
  };

  const updateProviderSessionDefaults = async (
    updates: ProviderSessionDefaults,
  ): Promise<void> => {
    if (!selectedProvider) return;

    await updateNewSessionDefaults(
      withProviderSessionDefaults(
        { ...savedDefaults, provider: selectedProvider.name },
        selectedProvider.name,
        updates,
        {
          model:
            selectedProvider.name === "claude"
              ? resolveModel(getModelSetting())
              : undefined,
          thinkingMode,
          effortLevel,
        },
      ),
    );
  };

  const updatePromptCacheKeepalive = async (
    updates: Partial<{
      mode: PromptCacheKeepaliveMode;
      inactivityMinutes: number;
    }>,
  ): Promise<void> => {
    if (!selectedProvider) return;

    const current = settings?.promptCacheKeepalive ?? {};
    const providersByName = { ...current.providers };
    providersByName[selectedProvider.name] = {
      ...providersByName[selectedProvider.name],
      ...updates,
    };

    try {
      await updateSetting("promptCacheKeepalive", {
        ...current,
        providers: providersByName,
      });
      showToast(t("promptCacheKeepaliveSaved"), "success");
    } catch (err) {
      showToast(
        err instanceof Error ? err.message : t("promptCacheKeepaliveSaveError"),
        "error",
      );
    }
  };

  const handleProviderChange = async (providerName: ProviderName) => {
    const provider = availableProviders.find((p) => p.name === providerName);
    if (!provider) return;
    const providerModels = provider.models ?? [];
    const nextModel =
      getPreferredProviderModel(provider.name, providerModels, savedDefaults) ??
      undefined;
    await updateNewSessionDefaults(
      withProviderSessionDefaults(
        { ...savedDefaults, provider: provider.name },
        provider.name,
        { model: nextModel },
        {
          model:
            provider.name === "claude"
              ? resolveModel(getModelSetting())
              : undefined,
          thinkingMode,
          effortLevel,
        },
      ),
    );
  };

  const handleDefaultModelChange = async (modelId: string) => {
    if (!selectedProvider) return;

    await updateProviderSessionDefaults({ model: modelId });
  };

  return (
    <SettingsSection
      title={t("modelSettingsSessionDefaultsTitle")}
      keywords={[
        "session defaults",
        "default model",
        "provider",
        "permission mode",
        "thinking",
        "recap",
        "prompt suggestions",
        "compact",
        "early compact",
        "context early",
        "autocompact",
        "prompt cache keepalive",
        "sandbox bubblewrap project writes",
        "helper model",
        "fork summary",
      ]}
    >
      <div className="settings-group">
        <div className="settings-session-defaults-panel">
          {canConfigureSessionSandbox && (
            <SettingsItem
              id="session-default-sandbox"
              as="label"
              label={t("modelSettingsSandboxDefaultTitle")}
              description={`${t("newSessionSandboxDescription")} ${t("newSessionSandboxAvailability")}`}
              keywords={[
                "sandbox",
                "bubblewrap",
                "project writes",
                t("newSessionSandboxLabel"),
              ]}
              valueText={
                savedDefaults?.sandboxLevel === "project-write"
                  ? t("newSessionSandboxLabel")
                  : undefined
              }
              className="new-session-helper-section session-default-sandbox-section settings-item--session-default-block"
            >
              <input
                type="checkbox"
                checked={savedDefaults?.sandboxLevel === "project-write"}
                disabled={settingsLoading}
                onChange={(event) => {
                  const enabled = event.currentTarget.checked;
                  void updateNewSessionDefaults({
                    sandboxLevel: enabled ? "project-write" : "none",
                    ...(enabled && savedRecapMode === "side-session"
                      ? { recapMode: "off" }
                      : {}),
                  });
                }}
                aria-label={t("modelSettingsSandboxDefaultTitle")}
              />
            </SettingsItem>
          )}

          <div className="session-default-discovery-row">
            <SettingsItem
              id="session-default-recap"
              label={t("newSessionRecapTitle")}
              keywords={["recap", "away summary", "side session", "fork"]}
              valueText={recapModeLabels[selectedRecapMode]}
              className="new-session-helper-section session-default-recap-section settings-item--session-default-block settings-item--wide-control"
              after={
                selectedRecapMode !== "off" ? (
                  <RecapAfterSecondsControl
                    value={selectedRecapAfterSeconds}
                    disabled={settingsLoading}
                    label={recapAfterSecondsInlineLabels[selectedRecapMode]}
                    mode={selectedRecapMode}
                    className="recap-after-seconds-control--inline"
                    onCommit={(seconds) =>
                      updateNewSessionDefaults({ recapAfterSeconds: seconds })
                    }
                  />
                ) : undefined
              }
            >
              <div className="new-session-helper-options">
                {availableRecapModes.map((modeValue) => (
                  <button
                    key={modeValue}
                    type="button"
                    className={`new-session-helper-option ${
                      selectedRecapMode === modeValue ? "selected" : ""
                    }`}
                    onClick={() =>
                      void updateNewSessionDefaults({ recapMode: modeValue })
                    }
                    disabled={
                      settingsLoading ||
                      (canConfigureSessionSandbox &&
                        savedDefaults?.sandboxLevel === "project-write" &&
                        modeValue === "side-session")
                    }
                    title={getRecapModeDescription(
                      modeValue,
                      t,
                      selectedRecapAfterSeconds,
                    )}
                  >
                    <span className={`mode-option-dot recap-${modeValue}`} />
                    <span>{recapModeLabels[modeValue]}</span>
                  </button>
                ))}
              </div>
            </SettingsItem>

            <SettingsItem
              id="session-default-suggestions"
              label={t("newSessionPromptSuggestionsTitle")}
              keywords={["suggestions", "prompt suggestions", "nudge"]}
              valueText={
                promptSuggestionModeLabels[selectedPromptSuggestionMode]
              }
              className="new-session-helper-section session-default-suggestions-section settings-item--session-default-block settings-item--wide-control"
            >
              <div className="new-session-helper-options">
                {availablePromptSuggestionModes.map((modeValue) => (
                  <button
                    key={modeValue}
                    type="button"
                    className={`new-session-helper-option ${
                      selectedPromptSuggestionMode === modeValue
                        ? "selected"
                        : ""
                    }`}
                    onClick={() =>
                      void updateNewSessionDefaults({
                        promptSuggestionMode: modeValue,
                      })
                    }
                    disabled={settingsLoading}
                    title={promptSuggestionModeDescriptions[modeValue]}
                  >
                    <span
                      className={`mode-option-dot suggestion-${modeValue}`}
                    />
                    <span>{promptSuggestionModeLabels[modeValue]}</span>
                  </button>
                ))}
              </div>
            </SettingsItem>
          </div>

          {supportsPermissionMode && (
            <SettingsItem
              id="session-default-permission-mode"
              label={t("newSessionModeTitle")}
              keywords={["permission mode", "bypass", "plan", "accept edits"]}
              valueText={modeLabels[effectiveDefaultPermissionMode]}
              className="new-session-mode-section session-default-mode-section settings-item--session-default-block settings-item--wide-control"
            >
              <div className="mode-options">
                {permissionModeOptions.map((modeValue) => (
                  <button
                    key={modeValue}
                    type="button"
                    className={`mode-option ${
                      effectiveDefaultPermissionMode === modeValue
                        ? "selected"
                        : ""
                    }`}
                    onClick={() =>
                      void updateNewSessionDefaults({
                        permissionMode: modeValue,
                      })
                    }
                    disabled={settingsLoading}
                  >
                    <span className={`mode-option-dot mode-${modeValue}`} />
                    <div className="mode-option-content">
                      <span className="mode-option-label">
                        {modeLabels[modeValue]}
                      </span>
                      <span className="mode-option-desc">
                        {modeDescriptions[modeValue]}
                      </span>
                    </div>
                  </button>
                ))}
              </div>
            </SettingsItem>
          )}

          <SettingsItem
            id="session-default-show-thinking"
            label={t("showThinkingTitle")}
            description={t("showThinkingHint")}
            keywords={["show thinking", "reasoning", "display thinking"]}
            valueText={String(showThinking)}
            className="new-session-helper-section session-default-show-thinking-section settings-item--session-default-block settings-item--wide-control"
          >
            <ShowThinkingControls
              value={showThinking}
              onChange={setShowThinking}
              t={t}
              showLabel={false}
            />
          </SettingsItem>

          <SettingsItem
            id="session-default-fork-summary"
            as="label"
            label={t("modelSettingsForkSummaryAutoOpenTitle")}
            description={t("modelSettingsForkSummaryAutoOpenDescription")}
            keywords={[
              "fork",
              "fork summary",
              "forked session",
              t("modelSettingsForkSummaryAutoOpenLabel"),
            ]}
            valueText={
              forkSummaryAutoOpen
                ? t("modelSettingsForkSummaryAutoOpenLabel")
                : undefined
            }
            className="new-session-helper-section session-default-fork-summary-section settings-item--session-default-block"
          >
            <input
              type="checkbox"
              checked={forkSummaryAutoOpen}
              onChange={(e) => setForkSummaryAutoOpen(e.target.checked)}
              aria-label={t("modelSettingsForkSummaryAutoOpenLabel")}
            />
          </SettingsItem>

          <SettingsItem
            id="session-default-provider"
            label={t("modelSettingsDefaultProviderTitle")}
            description={t("modelSettingsDefaultProviderDescription")}
            keywords={[
              "provider",
              "ai provider",
              t("newSessionProviderTitle"),
              ...availableProviders.map((p) => p.displayName),
            ]}
            valueText={selectedProvider?.displayName}
            className="new-session-provider-section session-default-provider-section settings-item--session-default-block settings-item--wide-control"
          >
            <div className="provider-options">
              {availableProviders.map((provider) => (
                <button
                  key={provider.name}
                  type="button"
                  className={`provider-option ${
                    selectedProvider?.name === provider.name ? "selected" : ""
                  }`}
                  onClick={() => void handleProviderChange(provider.name)}
                  disabled={providersLoading || settingsLoading}
                >
                  <span
                    className={`provider-option-dot provider-${provider.name}`}
                  />
                  <div className="provider-option-content">
                    <span className="provider-option-label">
                      {provider.displayName}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </SettingsItem>

          <SettingsItem
            id="session-default-model"
            label={t("modelSettingsDefaultModelTitle")}
            description={t("modelSettingsDefaultModelDescription")}
            keywords={["model", "default model", t("newSessionModelTitle")]}
            valueText={selectedModel ?? undefined}
            className="new-session-model-section session-default-model-section settings-item--session-default-block settings-item--wide-control"
          >
            <div className="new-session-model-field">
              {selectedModels.length > 0 ? (
                <FilterDropdown
                  label={t("newSessionModelTitle")}
                  options={modelOptions}
                  selected={selectedModel ? [selectedModel] : []}
                  onChange={(selected) => {
                    const nextModel = selected[0];
                    if (nextModel) void handleDefaultModelChange(nextModel);
                  }}
                  multiSelect={false}
                  placeholder={t("newSessionModelPlaceholder")}
                  fullWidth
                />
              ) : (
                <span className="model-settings-empty">
                  {t("modelSwitchEmpty")}
                </span>
              )}
            </div>
          </SettingsItem>

          {showCompactThreshold && selectedModel && (
            <YaCompactContextEarlyControl
              id="session-default-compact-early"
              modelId={selectedModel}
              contextWindow={selectedModelInfo?.contextWindow}
              storedPercent={storedCompactPercent}
              map={settings?.clientDefaults?.compactAtContextPercent}
              updateSetting={updateSetting}
              disabled={settingsLoading}
              className="new-session-helper-section session-default-compact-section settings-item--session-default-block settings-item--wide-control"
            />
          )}

          {showClaudeAutoCompactMirror && (
            <ClaudeAutoCompactPercentOverrideControl
              id="session-default-claude-auto-compact"
              value={settings?.claudeAutoCompactPercentOverride}
              updateSetting={updateSetting}
              description={t("providersClaudeAutoCompactMirrorDescription")}
              searchable={false}
            />
          )}

          {showCompactThreshold &&
            selectedProvider?.supportsNativeCompactThreshold === true && (
              <SettingsItem
                id="session-default-force-ya-compaction"
                as="label"
                label={t("modelSettingsForceYaCompactionLabel")}
                description={t("modelSettingsForceYaCompactionDescription")}
                keywords={[
                  "force ya",
                  "orchestrated compaction",
                  "ya compact",
                  "/compact",
                ]}
                valueText={
                  forceYaOrchestratedCompaction
                    ? t("modelSettingsForceYaCompactionLabel")
                    : undefined
                }
                className="new-session-helper-section session-default-force-ya-section settings-item--session-default-block"
              >
                <input
                  type="checkbox"
                  checked={forceYaOrchestratedCompaction}
                  disabled={settingsLoading}
                  onChange={(event) => {
                    void updateSetting("clientDefaults", {
                      forceYaOrchestratedCompaction:
                        event.currentTarget.checked,
                    });
                  }}
                  aria-label={t("modelSettingsForceYaCompactionLabel")}
                />
              </SettingsItem>
            )}

          {showThinkingControls && (
            <SettingsItem
              id="session-default-thinking"
              label={t("modelSettingsThinkingTitle")}
              description={t("modelSettingsThinkingDescription")}
              keywords={["thinking", "effort", "reasoning mode"]}
              valueText={`${effectiveThinkingMode} ${effectiveEffortLevel ?? ""}`.trim()}
              className="new-session-helper-section session-default-thinking-section settings-item--session-default-block settings-item--wide-control"
            >
              <ThinkingControlsPanel
                mode={effectiveThinkingMode}
                modeOptions={thinkingModeOptions}
                onSetMode={(mode: ThinkingMode) =>
                  void updateProviderSessionDefaults({ thinkingMode: mode })
                }
                level={effectiveEffortLevel}
                effortOptions={effortOptions}
                onSetEffort={(level: EffortLevel) =>
                  void updateProviderSessionDefaults({ effortLevel: level })
                }
                onSetEffortMode={(level: EffortLevel) =>
                  void updateProviderSessionDefaults({
                    thinkingMode: "on",
                    effortLevel: level,
                  })
                }
                showThinkingControl={false}
                provider={selectedProvider?.name}
                t={t}
                className="thinking-controls-panel--inline session-default-thinking-controls"
              />
            </SettingsItem>
          )}

          {showHelperSideModel && (
            <SettingsItem
              id="session-default-helper-model"
              label={t("helperSideModelTitle")}
              description={t("helperSideModelDescription")}
              keywords={[
                "helper model",
                "tailed recap",
                "side session model",
                "recap model",
              ]}
              valueText={selectedHelperSideModel}
              className="new-session-helper-section session-default-helper-model-section settings-item--session-default-block settings-item--wide-control"
            >
              <FilterDropdown
                label={t("helperSideModelTitle")}
                options={helperSideModelOptions}
                selected={[selectedHelperSideModel]}
                onChange={(selected) => {
                  const helperSideModel =
                    selected[0] ?? HELPER_SIDE_MODEL_CHEAPEST;
                  void updateProviderSessionDefaults({ helperSideModel });
                }}
                multiSelect={false}
                placeholder={t("helperSideModelCheapest")}
                fullWidth
              />
            </SettingsItem>
          )}

          {showPromptCacheKeepalive && selectedProvider && (
            <SettingsItem
              id="session-default-prompt-cache"
              label={t("promptCacheKeepaliveTitle")}
              description={[
                t("promptCacheKeepaliveDescription", {
                  provider: selectedProvider.displayName,
                }),
                t("promptCacheKeepaliveCadenceHint"),
              ].join(" ")}
              keywords={[
                "prompt cache",
                "keepalive",
                "cache refresh",
                "inactivity",
              ]}
              valueText={`${selectedPromptCacheKeepalive.mode} ${selectedPromptCacheKeepalive.inactivityMinutes}m`}
              className="new-session-helper-section session-default-cache-keepalive-section settings-item--session-default-block settings-item--wide-control"
            >
              <div className="session-default-cache-keepalive-controls">
                <div className="new-session-helper-options">
                  {PROMPT_CACHE_KEEPALIVE_MODE_ORDER.map((modeValue) => (
                    <button
                      key={modeValue}
                      type="button"
                      className={`new-session-helper-option ${
                        selectedPromptCacheKeepalive.mode === modeValue
                          ? "selected"
                          : ""
                      }`}
                      onClick={() =>
                        void updatePromptCacheKeepalive({ mode: modeValue })
                      }
                      disabled={settingsLoading}
                      title={promptCacheKeepaliveModeDescriptions[modeValue]}
                    >
                      <span
                        className={`mode-option-dot keepalive-${modeValue}`}
                      />
                      <span>{promptCacheKeepaliveModeLabels[modeValue]}</span>
                    </button>
                  ))}
                </div>
                <label className="prompt-cache-keepalive-cadence">
                  <span>{t("promptCacheKeepaliveCadenceLabel")}</span>
                  <input
                    key={`${selectedProvider.name}-${selectedPromptCacheKeepalive.inactivityMinutes}`}
                    type="number"
                    min={1}
                    max={1440}
                    step={1}
                    defaultValue={
                      selectedPromptCacheKeepalive.inactivityMinutes
                    }
                    disabled={
                      settingsLoading ||
                      selectedPromptCacheKeepalive.mode === "off"
                    }
                    aria-label={t("promptCacheKeepaliveCadenceAria")}
                    onBlur={(event) => {
                      const minutes = normalizeKeepaliveMinutes(
                        Number(event.currentTarget.value),
                      );
                      if (minutes === null) {
                        event.currentTarget.value = String(
                          selectedPromptCacheKeepalive.inactivityMinutes,
                        );
                        return;
                      }
                      event.currentTarget.value = String(minutes);
                      if (
                        minutes !==
                        selectedPromptCacheKeepalive.inactivityMinutes
                      ) {
                        void updatePromptCacheKeepalive({
                          inactivityMinutes: minutes,
                        });
                      }
                    }}
                  />
                  <span>{t("promptCacheKeepaliveCadenceUnit")}</span>
                </label>
              </div>
            </SettingsItem>
          )}
        </div>
      </div>

      {selectedProvider?.name === "claude" && (
        <div className="settings-group">
          <SettingsItem
            label={t("modelSettingsModelTitle")}
            description={t("modelSettingsModelDescription")}
            className="model-settings-item"
          >
            <div className="font-size-selector model-settings-chip-group">
              {MODEL_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  className={`font-size-option ${model === opt.value ? "active" : ""}`}
                  onClick={() => setModel(opt.value)}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </SettingsItem>
        </div>
      )}
    </SettingsSection>
  );
}
