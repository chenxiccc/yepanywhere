import {
  VOICE_INPUT_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  type KeyboardEvent as ReactKeyboardEvent,
  useCallback,
  useId,
  useMemo,
} from "react";
import {
  FilterDropdown,
  type FilterOption,
} from "../../components/FilterDropdown";
import { SpeechSmartTurnControls } from "../../components/SpeechSmartTurnControls";
import { useModelSettings } from "../../hooks/useModelSettings";
import { useBrowserXaiSttApiKey } from "../../hooks/useBrowserXaiSttApiKey";
import { useRemoteBasePath } from "../../hooks/useRemoteBasePath";
import { useSpeechCaptureSettings } from "../../hooks/useSpeechCaptureSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  canSpeechMethodStream,
  getSpeechMethodCapabilities,
  getSpeechMethods,
  isServerRoutedSpeechMethod,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../../lib/speechProviders/methods";
import {
  cleanParakeetSpeechModel,
  getCompatibleParakeetModelForBackend,
  getParakeetModelBackendLabel,
  getParakeetSpeechPresetValue,
  isParakeetModelBackend,
  PARAKEET_SPEECH_MODEL_PRESETS,
  type ParakeetModelBackendId,
  resolveParakeetModelBackend,
} from "../../lib/speechProviders/parakeetModels";
import { prewarmYaServerSpeechBackend } from "../../lib/speechProviders/YaServerProvider";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

export function SpeechSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("speechSettingsTitle"));
  const {
    voiceInputEnabled,
    setVoiceInputEnabled,
    speechMethod,
    hasStoredSpeechMethod,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
    parakeetSpeechModel,
    setParakeetSpeechModel,
  } = useModelSettings();
  const parakeetModelPresetId = useId();
  const parakeetModelInputId = useId();
  const { keepMicWarm, setKeepMicWarm } = useSpeechCaptureSettings();
  const {
    browserXaiSttApiKey,
    hasBrowserXaiSttApiKey,
    setBrowserXaiSttApiKey,
  } = useBrowserXaiSttApiKey();
  const relayTransport = useRemoteBasePath() !== "";
  const { version: versionInfo, loading: versionLoading } = useVersion();
  const undoState = useMemo(
    () => ({
      voiceInputEnabled,
      speechMethod,
      speechSmartTurnSettings,
      keepMicWarm,
      parakeetSpeechModel,
    }),
    [
      voiceInputEnabled,
      speechMethod,
      speechSmartTurnSettings,
      keepMicWarm,
      parakeetSpeechModel,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      setVoiceInputEnabled(snapshot.voiceInputEnabled);
      setSpeechMethod(snapshot.speechMethod);
      setSpeechSmartTurnSettings(snapshot.speechSmartTurnSettings);
      setKeepMicWarm(snapshot.keepMicWarm);
      setParakeetSpeechModel(snapshot.parakeetSpeechModel);
    },
    [
      setVoiceInputEnabled,
      setSpeechMethod,
      setSpeechSmartTurnSettings,
      setKeepMicWarm,
      setParakeetSpeechModel,
    ],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);
  const serverVoiceEnabled =
    versionInfo?.capabilities === undefined
      ? true
      : serverHasCapability(versionInfo, VOICE_INPUT_CAPABILITY);
  const serverBackends = versionInfo?.voiceBackends ?? [];
  const backendStatuses = versionInfo?.voiceBackendStatuses ?? [];
  const discoverableServerBackends =
    backendStatuses.length > 0
      ? backendStatuses.map((backend) => backend.id)
      : serverBackends;
  const backendOptions: FilterOption<SpeechMethodId>[] = getSpeechMethods(
    discoverableServerBackends,
    undefined,
    { directXaiAvailable: hasBrowserXaiSttApiKey },
  ).map((method) => {
    const backend = backendStatuses.find((entry) => entry.id === method.id);
    const validating = backend?.validationStatus === "pending";
    const unavailable = backend?.validationStatus === "disabled";
    return {
      value: method.id,
      label: method.label,
      description: validating
        ? t("speechSettingsBackendValidating")
        : unavailable
          ? backend.disabledReason || t("speechSettingsBackendUnavailable")
          : method.description,
      disabled: validating || unavailable,
    };
  });
  const selectedBackend = resolveSpeechMethod(
    speechMethod,
    serverBackends,
    hasStoredSpeechMethod,
    { directXaiAvailable: hasBrowserXaiSttApiKey },
  );
  const selectedBackendLabel =
    backendOptions.find((option) => option.value === selectedBackend)?.label ??
    selectedBackend;
  const selectedBackendCapabilities = getSpeechMethodCapabilities(
    selectedBackend,
    versionInfo?.voiceBackendCapabilities,
  );
  const selectedBackendServerRouted =
    isServerRoutedSpeechMethod(selectedBackend);
  const showParakeetModelControls = isParakeetModelBackend(selectedBackend);
  const selectedParakeetPreset =
    getParakeetSpeechPresetValue(parakeetSpeechModel);
  const enabledParakeetBackends = useMemo(() => {
    const backends: ParakeetModelBackendId[] = [];
    const addBackend = (backendId: string) => {
      if (isParakeetModelBackend(backendId) && !backends.includes(backendId)) {
        backends.push(backendId);
      }
    };
    addBackend(selectedBackend);
    for (const backendId of serverBackends) {
      addBackend(backendId);
    }
    return backends;
  }, [selectedBackend, serverBackends]);
  const selectedBackendCanStream = canSpeechMethodStream({
    methodId: selectedBackend,
    serverCapabilities: versionInfo?.voiceBackendCapabilities,
    relayTransport,
    relayedServerSpeechAvailable: !selectedBackendServerRouted,
  });
  const supportsSelectedSmartTurn =
    selectedBackendCanStream && selectedBackendCapabilities.smartTurn === true;
  const smartTurnUnavailableHint =
    relayTransport && selectedBackend !== "browser-native"
      ? t("speechSettingsStreamingRelayUnavailable")
      : t("speechSettingsSmartTurnUnavailable", {
          backend: selectedBackendLabel,
        });
  const prewarmParakeetModel = useCallback(
    (modelValue: string, backendId: SpeechMethodId = selectedBackend) => {
      if (!isParakeetModelBackend(backendId)) return;
      const model = cleanParakeetSpeechModel(modelValue);
      void prewarmYaServerSpeechBackend(backendId, model).catch(
        (err: unknown) => {
          console.warn(
            "[YaSTT] Speech model prewarm failed",
            err instanceof Error ? err.message : String(err),
          );
        },
      );
    },
    [selectedBackend],
  );
  const handleParakeetModelKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      prewarmParakeetModel(event.currentTarget.value);
    },
    [prewarmParakeetModel],
  );
  const selectParakeetPreset = useCallback(
    (modelValue: string) => {
      const model = cleanParakeetSpeechModel(modelValue);
      const backendId = resolveParakeetModelBackend(
        model,
        selectedBackend,
        enabledParakeetBackends,
      );
      if (!backendId) return;
      setParakeetSpeechModel(model);
      if (backendId !== selectedBackend) {
        setSpeechMethod(backendId);
      }
      prewarmParakeetModel(model, backendId);
    },
    [
      enabledParakeetBackends,
      prewarmParakeetModel,
      selectedBackend,
      setParakeetSpeechModel,
      setSpeechMethod,
    ],
  );
  const prepareParakeetBackend = useCallback(
    (backendId: SpeechMethodId) => {
      if (!isParakeetModelBackend(backendId)) return;
      const model = getCompatibleParakeetModelForBackend(
        parakeetSpeechModel,
        backendId,
      );
      if (model !== cleanParakeetSpeechModel(parakeetSpeechModel)) {
        setParakeetSpeechModel(model);
      }
      prewarmParakeetModel(model, backendId);
    },
    [parakeetSpeechModel, prewarmParakeetModel, setParakeetSpeechModel],
  );

  return (
    <SettingsSection description={t("speechSettingsDescription")}>
      <div className="settings-group">
        <SettingsItem
          label={t("speechSettingsVoiceInputTitle")}
          description={t("speechSettingsVoiceInputDescription")}
          info={
            <>
              <strong>{t("speechSettingsVoiceInputTitle")}</strong>
              <p>{t("speechSettingsVoiceInputDescription")}</p>
              {!serverVoiceEnabled && (
                <p className="settings-hint">
                  {t("speechSettingsServerDisabled")}
                </p>
              )}
            </>
          }
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={voiceInputEnabled && serverVoiceEnabled}
              disabled={versionLoading || !serverVoiceEnabled}
              onChange={(event) => setVoiceInputEnabled(event.target.checked)}
              aria-label={t("speechSettingsVoiceInputTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>

        {showParakeetModelControls && (
          <SettingsItem
            label={t("speechSettingsParakeetModelTitle")}
            description={t("speechSettingsParakeetModelDescription")}
            className="model-settings-item"
          >
            <div className="speech-backend-settings-field">
              <select
                id={parakeetModelPresetId}
                className="settings-select speech-parakeet-model-select"
                value={selectedParakeetPreset}
                onChange={(event) => {
                  const preset = event.currentTarget.value;
                  if (!preset) return;
                  selectParakeetPreset(preset);
                }}
                aria-label={t("speechSettingsParakeetModelPresetLabel")}
              >
                <option value="">
                  {t("speechSettingsParakeetCustomModel")}
                </option>
                {PARAKEET_SPEECH_MODEL_PRESETS.map((preset) => {
                  const backendId = resolveParakeetModelBackend(
                    preset.value,
                    selectedBackend,
                    enabledParakeetBackends,
                  );
                  const requiredBackends = preset.supportedBackends
                    .map(getParakeetModelBackendLabel)
                    .join(" or ");
                  return (
                    <option
                      key={preset.value}
                      value={preset.value}
                      disabled={!backendId}
                    >
                      {backendId
                        ? preset.label
                        : `${preset.label} (${t(
                            "speechSettingsParakeetModelRequiresBackend",
                            { backend: requiredBackends },
                          )})`}
                    </option>
                  );
                })}
              </select>
              <input
                id={parakeetModelInputId}
                className="settings-input"
                value={parakeetSpeechModel}
                placeholder={t("speechSettingsParakeetModelPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) =>
                  setParakeetSpeechModel(event.currentTarget.value)
                }
                onBlur={(event) =>
                  prewarmParakeetModel(event.currentTarget.value)
                }
                onKeyDown={handleParakeetModelKeyDown}
                aria-label={t("speechSettingsParakeetModelInputLabel")}
              />
              <p className="settings-hint">
                {t("speechSettingsParakeetModelHint")}
              </p>
            </div>
          </SettingsItem>
        )}

        <SettingsItem
          label={t("speechSettingsBackendTitle")}
          description={t("speechSettingsBackendDescription")}
          valueText={selectedBackendLabel}
          className="model-settings-item"
          after={
            relayTransport &&
            selectedBackend === "ya-grok" && (
              <p className="settings-hint">
                {t("speechSettingsStreamingRelayUnavailable")}
              </p>
            )
          }
        >
          <div className="speech-backend-settings-field">
            <FilterDropdown
              label={t("speechSettingsBackendTitle")}
              options={backendOptions}
              selected={[selectedBackend]}
              onChange={(selected) => {
                const nextBackend = selected[0];
                if (!nextBackend) return;
                if (isParakeetModelBackend(nextBackend)) {
                  prepareParakeetBackend(nextBackend);
                }
                setSpeechMethod(nextBackend);
              }}
              multiSelect={false}
              placeholder={t("speechSettingsBackendPlaceholder")}
            />
            {serverBackends.length === 0 && (
              <p className="settings-hint">
                {t("speechSettingsNoServerBackends")}
              </p>
            )}
          </div>
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsXaiKeyTitle")}
          description={t("speechSettingsXaiKeyDescription")}
          className="model-settings-item"
        >
          <input
            type="password"
            className="settings-input"
            value={browserXaiSttApiKey}
            placeholder={t("speechSettingsXaiKeyPlaceholder")}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => {
              setBrowserXaiSttApiKey(event.currentTarget.value);
            }}
            aria-label={t("speechSettingsXaiKeyTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsKeepMicWarmTitle")}
          description={t("speechSettingsKeepMicWarmDescription")}
        >
          <label className="toggle-switch">
            <input
              type="checkbox"
              checked={keepMicWarm}
              onChange={(event) => setKeepMicWarm(event.target.checked)}
              aria-label={t("speechSettingsKeepMicWarmTitle")}
            />
            <span className="toggle-slider" />
          </label>
        </SettingsItem>

        <SettingsItem
          label={t("speechSettingsSmartTurnTitle")}
          description={t("speechSettingsSmartTurnDescription", {
            backend: selectedBackendLabel,
          })}
          className="model-settings-item"
        >
          {supportsSelectedSmartTurn ? (
            <SpeechSmartTurnControls
              settings={speechSmartTurnSettings}
              onChange={setSpeechSmartTurnSettings}
            />
          ) : (
            <p className="settings-hint">{smartTurnUnavailableHint}</p>
          )}
        </SettingsItem>
      </div>
    </SettingsSection>
  );
}
