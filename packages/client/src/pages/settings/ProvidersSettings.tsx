import {
  Fragment,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
  DEFAULT_IDLE_REAP_HOURS,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  MAX_IDLE_REAP_HOURS,
  NEVER_IDLE_REAP_HOURS,
  MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH,
  isValidClaudeAdditionalModelId,
  isValidClaudeAdditionalModelLabel,
  normalizeIdleReapHours,
  type ClaudeAdditionalModelSelection,
  type HelperTargetConfig,
  type ModelInfo,
  type ProviderInfo,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { api, type ServerSettings } from "../../api/client";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import { Modal, type ModalAnchorRect } from "../../components/ui/Modal";
import { useToastContext } from "../../contexts/ToastContext";
import { useCodexUpdateStatus } from "../../hooks/useCodexUpdateStatus";
import { useProviders } from "../../hooks/useProviders";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  ClaudeAutoCompactPercentOverrideControl,
  YaCompactContextEarlyControl,
} from "./compactSettingsControls";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { getProviderSessionDefaults } from "../../lib/newSessionDefaults";
import {
  helperTargetDescription,
  helperTargetValue,
} from "../../lib/helperTargets";
import { getAllProviders } from "../../providers/registry";

const DEFAULT_OLLAMA_SYSTEM_PROMPT =
  "You are a helpful coding assistant. You help users with software engineering tasks. You have access to tools for reading files, editing files, running shell commands, and searching code. Use tools when needed to answer questions or make changes. Be concise and direct.";
const DEFAULT_CLAUDE_LOGIN_COMMAND = "claude auth login --claudeai";
const CLAUDE_OLLAMA_DEPRECATION_DISMISSAL_KEY =
  "yep-anywhere:claude-ollama-deprecation-v1";
// Re-enable with topics/openai-compatible-helper-sessions.md.
const SHOW_HELPER_TARGETS_SETTINGS = false;

function shouldShowClaudeOllamaDeprecation(): boolean {
  try {
    return (
      window.localStorage.getItem(CLAUDE_OLLAMA_DEPRECATION_DISMISSAL_KEY) !==
      "dismissed"
    );
  } catch {
    return true;
  }
}

function rememberClaudeOllamaDeprecationDismissal(): void {
  try {
    window.localStorage.setItem(
      CLAUDE_OLLAMA_DEPRECATION_DISMISSAL_KEY,
      "dismissed",
    );
  } catch {
    // The notice still stays dismissed for this mounted settings pane.
  }
}

interface HelperTargetDraft {
  id?: string;
  name: string;
  baseUrl: string;
  model: string;
}

type UpdateServerSetting = <K extends keyof ServerSettings>(
  key: K,
  value: ServerSettings[K],
) => Promise<void>;

interface HelperTargetsSettingsProps {
  settings: ServerSettings | null;
  updateSetting: UpdateServerSetting;
}

const DEFAULT_HELPER_TARGET_DRAFT: HelperTargetDraft = {
  name: "Local vLLM",
  baseUrl: "http://localhost:8001/v1",
  model: "",
};

function createHelperTargetId(
  name: string,
  targets: readonly HelperTargetConfig[],
): string {
  const base =
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "helper-target";
  const existingIds = new Set(targets.map((target) => target.id));
  if (!existingIds.has(base)) return base;

  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existingIds.has(candidate)) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}

function draftFromTarget(target: HelperTargetConfig): HelperTargetDraft {
  return {
    id: target.id,
    name: target.name,
    baseUrl: target.baseUrl,
    model: target.model ?? "",
  };
}

function targetFromDraft(
  draft: HelperTargetDraft,
  targets: readonly HelperTargetConfig[],
): HelperTargetConfig {
  const name = draft.name.trim();
  const model = draft.model.trim();
  return {
    id: draft.id ?? createHelperTargetId(name, targets),
    name,
    kind: "openai-compatible",
    baseUrl: draft.baseUrl.trim(),
    ...(model ? { model } : {}),
  };
}

function mergeModelOptions(
  selectedModel: string,
  discoveredModels: readonly ModelInfo[],
): ModelInfo[] {
  if (
    selectedModel &&
    !discoveredModels.some((model) => model.id === selectedModel)
  ) {
    return [{ id: selectedModel, name: selectedModel }, ...discoveredModels];
  }
  return [...discoveredModels];
}

function HelperTargetsSettings({
  settings,
  updateSetting,
}: HelperTargetsSettingsProps) {
  const { t } = useI18n();
  const targets = settings?.helperTargets ?? [];
  const [draft, setDraft] = useState<HelperTargetDraft>(
    DEFAULT_HELPER_TARGET_DRAFT,
  );
  const [editingId, setEditingId] = useState<string | null>(null);
  const [discoveredModels, setDiscoveredModels] = useState<ModelInfo[]>([]);
  const [isSaving, setIsSaving] = useState(false);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const modelFieldId = useId();

  const resetDraft = useCallback(() => {
    setDraft(DEFAULT_HELPER_TARGET_DRAFT);
    setEditingId(null);
    setDiscoveredModels([]);
    setMessage(null);
    setError(null);
  }, []);

  const beginEdit = useCallback((target: HelperTargetConfig) => {
    setDraft(draftFromTarget(target));
    setEditingId(target.id);
    setDiscoveredModels(
      target.model ? [{ id: target.model, name: target.model }] : [],
    );
    setMessage(null);
    setError(null);
  }, []);

  const deleteTarget = useCallback(
    async (targetId: string) => {
      setIsSaving(true);
      setError(null);
      try {
        await updateSetting(
          "helperTargets",
          targets.filter((target) => target.id !== targetId),
        );
        if (editingId === targetId) {
          resetDraft();
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : t("helperTargetsSaveError"),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [editingId, resetDraft, t, targets, updateSetting],
  );

  const discoverModels = useCallback(async () => {
    setIsDiscovering(true);
    setError(null);
    setMessage(null);
    try {
      const result = await api.discoverHelperTargetModels(draft.baseUrl);
      setDraft((prev) => ({ ...prev, baseUrl: result.baseUrl }));
      setDiscoveredModels(result.models);
      setMessage(
        t("helperTargetsDiscovered", {
          count: String(result.models.length),
        }),
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("helperTargetsLoadError"),
      );
    } finally {
      setIsDiscovering(false);
    }
  }, [draft.baseUrl, t]);

  const saveTarget = useCallback(async () => {
    if (!draft.name.trim() || !draft.baseUrl.trim()) {
      setError(t("helperTargetsInvalid"));
      return;
    }

    const nextTarget = targetFromDraft(draft, targets);
    const nextTargets = editingId
      ? targets.map((target) => (target.id === editingId ? nextTarget : target))
      : [...targets, nextTarget];

    setIsSaving(true);
    setError(null);
    try {
      await updateSetting("helperTargets", nextTargets);
      resetDraft();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("helperTargetsSaveError"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [draft, editingId, resetDraft, t, targets, updateSetting]);

  const modelOptions = mergeModelOptions(draft.model, discoveredModels);

  return (
    <SettingsItem
      label={t("helperTargetsTitle")}
      description={t("helperTargetsDescription")}
      className="helper-targets-settings"
      info={
        <>
          <strong>{t("helperTargetsTitle")}</strong>
          <p>{t("helperTargetsDescription")}</p>
          <p className="settings-hint">{t("helperTargetsRuntimeNote")}</p>
        </>
      }
    >
      <HideInSettingsSearch>
        <div className="helper-targets-panel">
          {targets.length === 0 ? (
            <p className="settings-hint">{t("helperTargetsEmpty")}</p>
          ) : (
            <div className="helper-target-list">
              {targets.map((target) => (
                <div key={target.id} className="helper-target-row">
                  <div className="helper-target-row-main">
                    <strong>{target.name}</strong>
                    <span>{helperTargetDescription(target)}</span>
                    <code>
                      {t("helperTargetsIdPrefix")} {helperTargetValue(target)}
                    </code>
                  </div>
                  <div className="helper-target-row-actions">
                    <button
                      type="button"
                      className="settings-button settings-button-secondary"
                      onClick={() => beginEdit(target)}
                      disabled={isSaving}
                    >
                      {t("helperTargetsEdit")}
                    </button>
                    <button
                      type="button"
                      className="settings-button settings-button-secondary"
                      onClick={() => void deleteTarget(target.id)}
                      disabled={isSaving}
                    >
                      {t("helperTargetsDelete")}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="helper-target-editor">
            <label>
              <span>{t("helperTargetsNameLabel")}</span>
              <input
                type="text"
                className="settings-input"
                value={draft.name}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, name: event.target.value }))
                }
              />
            </label>
            <label>
              <span>{t("helperTargetsBaseUrlLabel")}</span>
              <input
                type="text"
                className="settings-input"
                value={draft.baseUrl}
                placeholder={t("helperTargetsBaseUrlPlaceholder")}
                onChange={(event) =>
                  setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))
                }
              />
            </label>
            <label htmlFor={modelFieldId}>
              <span>{t("helperTargetsModelLabel")}</span>
              {modelOptions.length > 0 ? (
                <select
                  id={modelFieldId}
                  className="settings-select"
                  value={draft.model}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      model: event.target.value,
                    }))
                  }
                >
                  <option value="">{t("helperTargetsModelDefault")}</option>
                  {modelOptions.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  id={modelFieldId}
                  type="text"
                  className="settings-input"
                  value={draft.model}
                  placeholder={t("helperTargetsModelPlaceholder")}
                  onChange={(event) =>
                    setDraft((prev) => ({
                      ...prev,
                      model: event.target.value,
                    }))
                  }
                />
              )}
            </label>
          </div>

          <div className="helper-target-actions">
            <button
              type="button"
              className="settings-button settings-button-secondary"
              onClick={() => void discoverModels()}
              disabled={isDiscovering || !draft.baseUrl.trim()}
            >
              {isDiscovering
                ? t("helperTargetsDiscovering")
                : t("helperTargetsDiscover")}
            </button>
            {editingId && (
              <button
                type="button"
                className="settings-button settings-button-secondary"
                onClick={resetDraft}
                disabled={isSaving}
              >
                {t("helperTargetsCancelEdit")}
              </button>
            )}
            <button
              type="button"
              className="settings-button"
              onClick={() => void saveTarget()}
              disabled={isSaving}
            >
              {isSaving
                ? t("providersSaving")
                : editingId
                  ? t("helperTargetsSave")
                  : t("helperTargetsAdd")}
            </button>
          </div>

          {message && <p className="settings-hint">{message}</p>}
          {error && <p className="settings-warning">{error}</p>}
        </div>
      </HideInSettingsSearch>
    </SettingsItem>
  );
}

function OllamaUrlInput() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [url, setUrl] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const serverValue = settings?.ollamaUrl ?? "";

  useEffect(() => {
    if (settings) {
      setUrl(settings.ollamaUrl ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSetting("ollamaUrl", url.trim() || undefined);
      setHasChanges(false);
    } catch {
      // Error handled by useServerSettings
    } finally {
      setIsSaving(false);
    }
  }, [url, updateSetting]);

  return (
    <div style={{ marginTop: "var(--space-2)", width: "100%" }}>
      <div
        style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}
      >
        <input
          type="text"
          className="settings-input"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value);
            setHasChanges(e.target.value !== serverValue);
          }}
          placeholder="http://localhost:11434"
          style={{ flex: 1 }}
        />
        <button
          type="button"
          className="settings-button"
          disabled={!hasChanges || isSaving}
          onClick={handleSave}
        >
          {isSaving ? t("providersSaving") : t("providersSave")}
        </button>
      </div>
      <span className="settings-hint">{t("providersOllamaUrlHint")}</span>
    </div>
  );
}

function OllamaUseFullSystemPrompt() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const enabled = settings?.ollamaUseFullSystemPrompt ?? false;

  return (
    <label
      style={{
        display: "flex",
        gap: "var(--space-2)",
        alignItems: "center",
        marginTop: "var(--space-2)",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(e) =>
          updateSetting("ollamaUseFullSystemPrompt", e.target.checked)
        }
      />
      <span>{t("providersUseFullPrompt")}</span>
      <span className="settings-hint" style={{ marginLeft: "auto" }}>
        {t("providersUseFullPromptHint")}
      </span>
    </label>
  );
}

function OllamaSystemPromptInput() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const [prompt, setPrompt] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);

  const serverValue = settings?.ollamaSystemPrompt ?? "";

  useEffect(() => {
    if (settings) {
      setPrompt(settings.ollamaSystemPrompt ?? "");
    }
  }, [settings]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      await updateSetting("ollamaSystemPrompt", prompt.trim() || undefined);
      setHasChanges(false);
    } catch {
      // Error handled by useServerSettings
    } finally {
      setIsSaving(false);
    }
  }, [prompt, updateSetting]);

  return (
    <div style={{ marginTop: "var(--space-2)", width: "100%" }}>
      <textarea
        className="settings-textarea"
        value={prompt}
        onChange={(e) => {
          setPrompt(e.target.value);
          setHasChanges(e.target.value !== serverValue);
        }}
        placeholder={DEFAULT_OLLAMA_SYSTEM_PROMPT}
        rows={4}
      />
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginTop: "var(--space-2)",
        }}
      >
        <span className="settings-hint">{t("providersOllamaPromptHint")}</span>
        <button
          type="button"
          className="settings-button"
          disabled={!hasChanges || isSaving}
          onClick={handleSave}
        >
          {isSaving ? t("providersSaving") : t("providersSave")}
        </button>
      </div>
    </div>
  );
}

function GrokBuildApiKeySettings() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const enabled = settings?.grokBuildUseXaiApiKey ?? false;

  return (
    <label
      style={{
        display: "flex",
        gap: "var(--space-2)",
        alignItems: "flex-start",
        marginTop: "var(--space-2)",
        cursor: "pointer",
      }}
    >
      <input
        type="checkbox"
        checked={enabled}
        onChange={(event) =>
          updateSetting("grokBuildUseXaiApiKey", event.target.checked)
        }
        style={{ marginTop: "0.2rem" }}
      />
      <span>
        <span>{t("providersGrokUseXaiApiKey")}</span>
        <span className="settings-hint" style={{ display: "block" }}>
          {t("providersGrokUseXaiApiKeyHint")}
        </span>
      </span>
    </label>
  );
}

function CodexUpdatePanel() {
  const { t } = useI18n();
  const { showToast } = useToastContext();
  const { settings, updateSetting } = useServerSettings();
  const {
    status,
    isChecking,
    isInstalling,
    error,
    installOutput,
    refresh,
    install,
  } = useCodexUpdateStatus();

  const policy = settings?.codexUpdatePolicy ?? "notify";
  const canAuto = status?.updateMethod === "npm";

  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        showToast(t("providersCodexUpdateCommandCopied"), "success");
      } catch {
        showToast(t("providersCodexUpdateCopyFailed"), "error");
      }
    },
    [showToast, t],
  );

  if (!status?.installed || !status.latest) {
    return null;
  }

  const updateAvailable = status.updateAvailable;

  return (
    <div style={{ marginTop: "var(--space-2)", width: "100%" }}>
      <div
        style={{
          display: "flex",
          gap: "var(--space-2)",
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        {updateAvailable ? (
          <span>
            <strong>{t("providersCodexUpdateAvailable")}</strong>{" "}
            {status.installed} → {status.latest}
          </span>
        ) : (
          <span className="settings-hint">
            {t("providersCodexUpdateUpToDate", {
              version: status.installed,
            })}
          </span>
        )}
        <button
          type="button"
          className="settings-button"
          onClick={() => void refresh(true)}
          disabled={isChecking}
          style={{ marginLeft: "auto" }}
        >
          {isChecking
            ? t("providersCodexUpdateChecking")
            : t("providersCodexUpdateCheckNow")}
        </button>
        {status.releaseUrl && updateAvailable && (
          <a
            href={status.releaseUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="settings-link"
          >
            {t("providersCodexUpdateReleaseNotes")}
          </a>
        )}
      </div>

      {updateAvailable && (
        <div
          style={{
            display: "flex",
            gap: "var(--space-2)",
            alignItems: "center",
            marginTop: "var(--space-2)",
            flexWrap: "wrap",
          }}
        >
          {status.updateMethod === "npm" ? (
            <button
              type="button"
              className="settings-button"
              onClick={() => void install()}
              disabled={isInstalling}
            >
              {isInstalling
                ? t("providersCodexUpdateInstalling")
                : t("providersCodexUpdateNow")}
            </button>
          ) : status.manualInstallCommand ? (
            <span className="settings-hint">
              {t("providersCodexUpdateWithInstaller")}
            </span>
          ) : null}
          {status.manualInstallCommand ? (
            <>
              <code
                style={{
                  padding: "2px 6px",
                  background: "var(--color-surface-raised, #f5f5f5)",
                  borderRadius: 4,
                  fontSize: "0.85em",
                }}
              >
                {status.manualInstallCommand}
              </code>
              <button
                type="button"
                className="settings-button"
                onClick={() => void copy(status.manualInstallCommand ?? "")}
              >
                {t("remoteSetupCopy")}
              </button>
            </>
          ) : status.updateMethod === "manual" ? (
            <span className="settings-hint">
              {t("providersCodexUpdateManualInstallHint")}
            </span>
          ) : null}
        </div>
      )}

      {error && (
        <p className="settings-hint" style={{ color: "var(--color-error)" }}>
          {error}
        </p>
      )}
      {installOutput && (
        <details style={{ marginTop: "var(--space-2)" }}>
          <summary className="settings-hint">
            {t("providersCodexUpdateInstallOutput")}
          </summary>
          <pre
            style={{
              fontSize: "0.8em",
              whiteSpace: "pre-wrap",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {installOutput}
          </pre>
        </details>
      )}

      <fieldset
        style={{
          border: "none",
          padding: 0,
          marginTop: "var(--space-3)",
          display: "flex",
          gap: "var(--space-3)",
          flexWrap: "wrap",
        }}
      >
        <legend className="settings-hint" style={{ marginBottom: 4 }}>
          {t("providersCodexUpdatePolicyTitle")}
        </legend>
        {(["auto", "notify", "off"] as const).map((value) => {
          const disabled = value === "auto" && !canAuto;
          return (
            <label
              key={value}
              style={{
                display: "inline-flex",
                gap: 4,
                alignItems: "center",
                opacity: disabled ? 0.55 : 1,
                cursor: disabled ? "not-allowed" : "pointer",
              }}
              title={
                disabled
                  ? t("providersCodexUpdatePolicyAutoUnavailable")
                  : undefined
              }
            >
              <input
                type="radio"
                name="codex-update-policy"
                value={value}
                checked={policy === value}
                disabled={disabled}
                onChange={() => void updateSetting("codexUpdatePolicy", value)}
              />
              <span>
                {value === "auto"
                  ? t("commonAuto")
                  : value === "notify"
                    ? t("providersCodexUpdatePolicyNotify")
                    : t("commonOff")}
              </span>
            </label>
          );
        })}
      </fieldset>
    </div>
  );
}

function OllamaSettings() {
  const { settings } = useServerSettings();
  const useFullPrompt = settings?.ollamaUseFullSystemPrompt ?? false;

  return (
    <>
      <OllamaUrlInput />
      <OllamaUseFullSystemPrompt />
      {!useFullPrompt && <OllamaSystemPromptInput />}
    </>
  );
}

function ClaudeGatewaySettings({
  reloadProviders,
  supportsAutostart,
}: {
  reloadProviders: () => Promise<void>;
  supportsAutostart: boolean;
}) {
  const exampleUrl = "http://localhost:4141";
  const { t } = useI18n();
  const { settings, updateSetting, updateSettings } = useServerSettings();
  const [url, setUrl] = useState("");
  const [startCommand, setStartCommand] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const serverValue = settings?.claudeGatewayUrl ?? "";
  const serverStartCommand = settings?.claudeGatewayStartCommand ?? "";
  const hasChanges =
    url.trim() !== serverValue ||
    (supportsAutostart && startCommand.trim() !== serverStartCommand);

  useEffect(() => {
    setUrl(settings?.claudeGatewayUrl ?? "");
  }, [settings?.claudeGatewayUrl]);

  useEffect(() => {
    setStartCommand(settings?.claudeGatewayStartCommand ?? "");
  }, [settings?.claudeGatewayStartCommand]);

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    try {
      if (supportsAutostart) {
        await updateSettings({
          claudeGatewayUrl: url.trim() || undefined,
          claudeGatewayStartCommand: startCommand.trim() || undefined,
        });
      } else {
        await updateSetting("claudeGatewayUrl", url.trim() || undefined);
      }
      await reloadProviders();
    } catch {
      // Error handled by useServerSettings.
    } finally {
      setIsSaving(false);
    }
  }, [
    reloadProviders,
    startCommand,
    supportsAutostart,
    updateSetting,
    updateSettings,
    url,
  ]);

  return (
    <div
      id="provider-claude-gateway-configuration"
      className="settings-subsection"
    >
      <h3>{t("providersClaudeGatewayTitle")}</h3>
      <p className="settings-hint">{t("providersClaudeGatewayDescription")}</p>
      <form
        className="claude-gateway-settings-control"
        onSubmit={(event) => {
          event.preventDefault();
          if (hasChanges && !isSaving) void handleSave();
        }}
      >
        <div className="claude-gateway-settings-row">
          <input
            type="url"
            className="settings-input"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            onFocus={() => {
              if (!url.trim()) setUrl(exampleUrl);
            }}
            placeholder={exampleUrl}
            aria-label={t("providersClaudeGatewayUrlAria")}
          />
          <button
            type="submit"
            className="settings-button"
            disabled={!hasChanges || isSaving}
          >
            {isSaving ? t("providersSaving") : t("providersSave")}
          </button>
        </div>
        {supportsAutostart && (
          <>
            <label className="claude-gateway-start-command">
              <span>{t("providersClaudeGatewayStartCommandLabel")}</span>
              <input
                type="text"
                className="settings-input"
                value={startCommand}
                maxLength={10_000}
                onChange={(event) => setStartCommand(event.target.value)}
                placeholder={t("providersClaudeGatewayStartCommandPlaceholder")}
                aria-label={t("providersClaudeGatewayStartCommandAria")}
              />
            </label>
            <p className="settings-hint">
              {t("providersClaudeGatewayStartCommandHint")}
            </p>
          </>
        )}
        <p className="settings-hint">
          {t("providersClaudeGatewayIsolationHint")}
        </p>
      </form>
    </div>
  );
}

function ClaudeGatewayDisableAgentSetting() {
  const { t } = useI18n();
  const { settings, updateSetting } = useServerSettings();
  const disabled = settings?.claudeGatewayDisableAgent ?? true;

  return (
    <div
      id="provider-claude-gateway-disable-agent"
      className="settings-subsection"
    >
      <label>
        <input
          type="checkbox"
          checked={disabled}
          aria-label={t("providersClaudeGatewayDisableAgentTitle")}
          onChange={(event) =>
            void updateSetting(
              "claudeGatewayDisableAgent",
              event.target.checked,
            )
          }
        />{" "}
        <strong>{t("providersClaudeGatewayDisableAgentTitle")}</strong>
      </label>
      <p className="settings-hint">
        {t("providersClaudeGatewayDisableAgentDescription")}
      </p>
    </div>
  );
}

function ClaudeLoginCommandPanel({
  command,
  onCopy,
}: {
  command: string;
  onCopy: (command: string) => void;
}) {
  const { t } = useI18n();

  return (
    <div className="settings-command-panel">
      <div
        className="settings-command-preview"
        role="group"
        aria-label={t("providersClaudeLoginCommandPreviewAria")}
      >
        <code>{command}</code>
      </div>
      <button
        type="button"
        className="settings-button"
        onClick={() => onCopy(command)}
      >
        {t("providersClaudeLoginCommandCopy")}
      </button>
    </div>
  );
}

function ClaudeYaCompactEarlyMirror({
  serverProviders,
  settings,
  updateSetting,
}: {
  serverProviders: ProviderInfo[];
  settings: ServerSettings | null;
  updateSetting: UpdateServerSetting;
}) {
  const { t } = useI18n();
  const claudeProvider = serverProviders.find((p) => p.name === "claude");
  const claudeDefaults = getProviderSessionDefaults(
    settings?.newSessionDefaults,
    "claude",
  );
  const claudeModelId =
    typeof claudeDefaults.model === "string" &&
    claudeDefaults.model !== "default"
      ? claudeDefaults.model
      : claudeProvider?.models?.[0]?.id;
  if (!claudeModelId || claudeModelId === "default") {
    return null;
  }
  const modelInfo = claudeProvider?.models?.find((m) => m.id === claudeModelId);
  const stored =
    settings?.clientDefaults?.compactAtContextPercent?.[claudeModelId] ?? 0;
  return (
    <YaCompactContextEarlyControl
      id="provider-ya-compact-early"
      modelId={claudeModelId}
      contextWindow={modelInfo?.contextWindow}
      storedPercent={stored}
      map={settings?.clientDefaults?.compactAtContextPercent}
      updateSetting={updateSetting}
      description={t("providersYaCompactEarlyMirrorDescription", {
        model: modelInfo?.name ?? claudeModelId,
      })}
      searchable={false}
    />
  );
}

interface ClaudeAdditionalModelsSettingsProps {
  modelOptions: readonly ModelInfo[];
  selections: readonly ClaudeAdditionalModelSelection[];
  updateSetting: UpdateServerSetting;
  reloadProviders: () => Promise<void>;
}

function ClaudeAdditionalModelsSettings({
  modelOptions,
  selections,
  updateSetting,
  reloadProviders,
}: ClaudeAdditionalModelsSettingsProps) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState<ModalAnchorRect | null>(null);
  const [customId, setCustomId] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedIds = useMemo(
    () => new Set(selections.map((selection) => selection.id)),
    [selections],
  );
  const choices = useMemo(() => {
    const maintainedIds = new Set(modelOptions.map((model) => model.id));
    return [
      ...modelOptions,
      ...selections
        .filter((selection) => !maintainedIds.has(selection.id))
        .map(
          (selection): ModelInfo => ({
            id: selection.id,
            name: selection.label,
            description:
              selection.origin === "registry"
                ? t("providersAdditionalModelsUnlistedDescription")
                : t("providersAdditionalModelsCustomDescription"),
            catalogGroup: "additional",
          }),
        ),
    ];
  }, [modelOptions, selections, t]);

  const summary =
    selections.length === 0
      ? t("providersAdditionalModelsNone")
      : selections.length === 1
        ? t("providersAdditionalModelsOne")
        : t("providersAdditionalModelsMany", {
            count: String(selections.length),
          });

  const saveSelections = useCallback(
    async (nextSelections: ClaudeAdditionalModelSelection[]) => {
      setIsSaving(true);
      setError(null);
      try {
        await updateSetting("claudeAdditionalModels", nextSelections);
        await reloadProviders();
      } catch (err) {
        setError(
          err instanceof Error
            ? err.message
            : t("providersAdditionalModelsSaveError"),
        );
      } finally {
        setIsSaving(false);
      }
    },
    [reloadProviders, t, updateSetting],
  );

  const toggleModel = useCallback(
    (model: ModelInfo) => {
      const nextSelections = selectedIds.has(model.id)
        ? selections.filter((selection) => selection.id !== model.id)
        : [
            ...selections,
            {
              id: model.id,
              label: model.name,
              origin: "registry" as const,
            },
          ];
      void saveSelections(nextSelections);
    },
    [saveSelections, selectedIds, selections],
  );

  const addCustomModel = useCallback(() => {
    const id = customId.trim();
    if (!isValidClaudeAdditionalModelId(id)) {
      setError(t("providersAdditionalModelsInvalidId"));
      return;
    }
    if (selectedIds.has(id)) {
      setError(t("providersAdditionalModelsDuplicateId"));
      return;
    }

    const maintained = modelOptions.find((model) => model.id === id);
    // A custom entry stores label = id, so the id must also satisfy the label
    // bounds the server enforces; a registry match carries the maintained name.
    if (!maintained && !isValidClaudeAdditionalModelLabel(id)) {
      setError(t("providersAdditionalModelsInvalidId"));
      return;
    }
    const nextSelection: ClaudeAdditionalModelSelection = maintained
      ? {
          id,
          label: maintained.name,
          origin: "registry",
        }
      : {
          id,
          label: id,
          origin: "custom",
        };
    setCustomId("");
    void saveSelections([...selections, nextSelection]);
  }, [customId, modelOptions, saveSelections, selectedIds, selections, t]);

  const openEditor = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    setAnchorRect(
      rect
        ? {
            bottom: rect.bottom,
            height: rect.height,
            left: rect.left,
            right: rect.right,
            top: rect.top,
            width: rect.width,
          }
        : null,
    );
    setError(null);
    setOpen(true);
  }, []);

  return (
    <>
      <SettingsItem
        id="provider-claude-additional-models"
        label={t("providersAdditionalModelsTitle")}
        description={t("providersAdditionalModelsDescription")}
        valueText={summary}
        className="providers-additional-models-setting"
      >
        <button
          ref={triggerRef}
          type="button"
          className="settings-button settings-button-secondary providers-additional-models-trigger"
          onClick={openEditor}
          aria-haspopup="dialog"
        >
          <span>{summary}</span>
          <span aria-hidden="true">▾</span>
        </button>
      </SettingsItem>
      {open && (
        <Modal
          title={t("providersAdditionalModelsTitle")}
          onClose={() => setOpen(false)}
          anchorRect={anchorRect}
        >
          <div className="providers-additional-models-editor">
            <p className="settings-hint">
              {t("providersAdditionalModelsEditorDescription")}
            </p>
            <div className="providers-additional-models-list">
              {choices.map((model) => (
                <label
                  key={model.id}
                  className="providers-additional-model-option"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(model.id)}
                    disabled={isSaving}
                    onChange={() => toggleModel(model)}
                  />
                  <span>
                    <strong>{model.name}</strong>
                    <code>{model.id}</code>
                    {model.description && (
                      <span className="settings-hint">{model.description}</span>
                    )}
                  </span>
                </label>
              ))}
            </div>
            <details className="providers-additional-models-custom">
              <summary>{t("providersAdditionalModelsCustomTitle")}</summary>
              <p className="settings-hint">
                {t("providersAdditionalModelsCustomHint")}
              </p>
              <div className="providers-additional-models-custom-row">
                <input
                  type="text"
                  className="settings-input"
                  value={customId}
                  maxLength={MAX_CLAUDE_ADDITIONAL_MODEL_ID_LENGTH}
                  placeholder={t("providersAdditionalModelsCustomPlaceholder")}
                  aria-label={t("providersAdditionalModelsCustomInputAria")}
                  onChange={(event) => setCustomId(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      addCustomModel();
                    }
                  }}
                />
                <button
                  type="button"
                  className="settings-button"
                  disabled={isSaving || !customId.trim()}
                  onClick={addCustomModel}
                >
                  {t("providersAdditionalModelsAdd")}
                </button>
              </div>
            </details>
            {isSaving && (
              <p className="settings-hint">{t("providersSaving")}</p>
            )}
            {error && <p className="settings-warning">{error}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}

export function ProvidersSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("providersSectionTitle"));
  const [showClaudeOllamaDeprecation, setShowClaudeOllamaDeprecation] =
    useState(shouldShowClaudeOllamaDeprecation);
  const { showToast } = useToastContext();
  const { providers: serverProviders, reload: reloadProviders } =
    useProviders();
  const { settings, updateSetting } = useServerSettings();
  const { version } = useVersion();
  const supportsAdditionalModels = serverHasCapability(
    version,
    CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  );
  const supportsClaudeGateway = serverHasCapability(
    version,
    CLAUDE_GATEWAY_CAPABILITY,
  );
  const supportsClaudeGatewayAutostart = serverHasCapability(
    version,
    CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  );
  const supportsClaudeGatewayDisableAgent = serverHasCapability(
    version,
    CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
  );
  const supportsIdleReapHours = serverHasCapability(
    version,
    IDLE_REAP_HOURS_SETTING_CAPABILITY,
  );
  const idleReapHours = settings?.idleReapHours ?? DEFAULT_IDLE_REAP_HOURS;

  const handleCopyClaudeLoginCommand = useCallback(
    async (command: string) => {
      try {
        await navigator.clipboard.writeText(command);
        showToast(t("providersClaudeLoginCommandCopied"), "success");
      } catch {
        showToast(t("providersClaudeLoginCommandCopyError"), "error");
      }
    },
    [showToast, t],
  );

  const dismissClaudeOllamaDeprecation = useCallback(() => {
    setShowClaudeOllamaDeprecation(false);
    rememberClaudeOllamaDeprecationDismissal();
  }, []);

  // Merge server detection status with client-side metadata
  const registeredProviders = getAllProviders();
  const providerDisplayList = registeredProviders.flatMap((clientProvider) => {
    const serverInfo = serverProviders.find(
      (p) => p.name === clientProvider.id,
    );
    if (clientProvider.id === "claude-ollama" && !serverInfo) {
      return [];
    }
    if (
      clientProvider.id === "claude-gateway" &&
      !serverInfo &&
      !supportsClaudeGateway
    ) {
      return [];
    }
    return [
      {
        ...clientProvider,
        installed: serverInfo?.installed ?? false,
        authenticated: serverInfo?.authenticated ?? false,
        loginCommand: serverInfo?.loginCommand,
        additionalModelOptions: serverInfo?.additionalModelOptions,
        supportsLaunchCompactPercentOverride:
          serverInfo?.supportsLaunchCompactPercentOverride === true,
      },
    ];
  });

  return (
    <SettingsSection description={t("providersSectionDescription")}>
      {SHOW_HELPER_TARGETS_SETTINGS && (
        <div className="settings-group">
          <HelperTargetsSettings
            settings={settings}
            updateSetting={updateSetting}
          />
        </div>
      )}
      <div className="settings-group">
        {supportsIdleReapHours && (
          <SettingsItem
            id="providers-idle-reap-hours"
            label={t("providersIdleReapHoursLabel")}
            description={t("providersIdleReapHoursDescription")}
            className="settings-item--wide-control"
            valueText={
              idleReapHours < 0
                ? t("providersIdleReapNever")
                : t("providersIdleReapHoursValue", {
                    value: idleReapHours,
                  })
            }
          >
            <div>
              <CommittedRangeNumberInput
                id="providers-idle-reap-hours-control"
                min={NEVER_IDLE_REAP_HOURS}
                max={MAX_IDLE_REAP_HOURS}
                numberMin={NEVER_IDLE_REAP_HOURS}
                numberMax={MAX_IDLE_REAP_HOURS}
                step={1}
                list="providers-idle-reap-hours-ticks"
                value={idleReapHours}
                unit={t("providersIdleReapHoursUnit")}
                ariaLabel={t("providersIdleReapHoursAria")}
                snapTextToStep={false}
                onCommit={(value) => {
                  void updateSetting(
                    "idleReapHours",
                    normalizeIdleReapHours(value),
                  );
                }}
              />
              <datalist id="providers-idle-reap-hours-ticks">
                <option
                  value={NEVER_IDLE_REAP_HOURS}
                  label={t("providersIdleReapNever")}
                />
                <option value="0" />
                <option value="24" />
                <option value="48" />
                <option value={MAX_IDLE_REAP_HOURS} />
              </datalist>
              <p className="settings-hint">{t("providersIdleReapNeverHint")}</p>
            </div>
          </SettingsItem>
        )}
        {providerDisplayList.map((provider) => (
          <Fragment key={provider.id}>
            <SettingsItem
              id={`provider-${provider.id}`}
              label={provider.displayName}
              description={provider.metadata.description}
              keywords={
                provider.id === "claude-gateway"
                  ? [
                      "gateway URL",
                      "start command",
                      "autostart",
                      "disable agent",
                    ]
                  : undefined
              }
              after={
                provider.id === "claude-ollama" &&
                showClaudeOllamaDeprecation ? (
                  <div className="provider-deprecation-notice" role="status">
                    <span>{t("providersClaudeOllamaDeprecationNotice")}</span>
                    <button
                      type="button"
                      className="provider-deprecation-notice__dismiss"
                      aria-label={t(
                        "providersClaudeOllamaDeprecationDismissAria",
                      )}
                      onClick={dismissClaudeOllamaDeprecation}
                    >
                      ×
                    </button>
                  </div>
                ) : undefined
              }
              info={
                <>
                  <div className="settings-item-header">
                    <strong>{provider.displayName}</strong>
                    {provider.installed ? (
                      <span className="settings-status-badge settings-status-detected">
                        {t("providersDetected")}
                      </span>
                    ) : (
                      <span className="settings-status-badge settings-status-not-detected">
                        {t("providersNotDetected")}
                      </span>
                    )}
                  </div>
                  <p>{provider.metadata.description}</p>
                  {provider.metadata.limitations.length > 0 && (
                    <ul className="settings-limitations">
                      {provider.metadata.limitations.map((limitation) => (
                        <li key={limitation}>{limitation}</li>
                      ))}
                    </ul>
                  )}
                  {provider.id === "claude" &&
                    provider.installed &&
                    !provider.authenticated && (
                      <div style={{ marginTop: "var(--space-2)" }}>
                        <p className="settings-hint">
                          {t("providersClaudeLoginHint")}
                        </p>
                        <ClaudeLoginCommandPanel
                          command={
                            provider.loginCommand ??
                            DEFAULT_CLAUDE_LOGIN_COMMAND
                          }
                          onCopy={(command) =>
                            void handleCopyClaudeLoginCommand(command)
                          }
                        />
                      </div>
                    )}
                  {provider.id === "claude-ollama" && <OllamaSettings />}
                  {provider.id === "grok" && <GrokBuildApiKeySettings />}
                  {provider.id === "claude-gateway" &&
                    supportsClaudeGateway && (
                      <>
                        <ClaudeGatewaySettings
                          reloadProviders={reloadProviders}
                          supportsAutostart={supportsClaudeGatewayAutostart}
                        />
                        {supportsClaudeGatewayDisableAgent && (
                          <ClaudeGatewayDisableAgentSetting />
                        )}
                      </>
                    )}
                  {provider.id === "codex" && provider.installed && (
                    <CodexUpdatePanel />
                  )}
                </>
              }
            >
              {provider.metadata.website && (
                <a
                  href={provider.metadata.website}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="settings-link"
                >
                  {t("providersWebsite")}
                </a>
              )}
            </SettingsItem>
            {provider.id === "claude" &&
              provider.supportsLaunchCompactPercentOverride && (
                <ClaudeAutoCompactPercentOverrideControl
                  id="provider-claude-auto-compact"
                  value={settings?.claudeAutoCompactPercentOverride}
                  updateSetting={updateSetting}
                />
              )}
            {provider.id === "claude" && (
              <ClaudeYaCompactEarlyMirror
                serverProviders={serverProviders}
                settings={settings}
                updateSetting={updateSetting}
              />
            )}
            {provider.id === "claude" && supportsAdditionalModels && (
              <ClaudeAdditionalModelsSettings
                modelOptions={provider.additionalModelOptions ?? []}
                selections={settings?.claudeAdditionalModels ?? []}
                updateSetting={updateSetting}
                reloadProviders={reloadProviders}
              />
            )}
          </Fragment>
        ))}
      </div>
    </SettingsSection>
  );
}
