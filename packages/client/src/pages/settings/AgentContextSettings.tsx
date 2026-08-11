import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DEFAULT_HEARTBEAT_TURN_TEXT,
  DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES,
  LATEX_MATH_RENDERING_CLIENT_CAPABILITY,
  buildEffectiveAgentContext,
} from "@yep-anywhere/shared";
import { useServerSettings } from "../../hooks/useServerSettings";
import { HeartbeatTextArea } from "../../components/HeartbeatTextArea";
import { useI18n } from "../../i18n";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const MAX_LENGTH = 10000;
const DEFAULT_HEARTBEAT_TEXT = DEFAULT_HEARTBEAT_TURN_TEXT;
const DEFAULT_HEARTBEAT_AFTER_MINUTES = DEFAULT_HEARTBEAT_TURNS_AFTER_MINUTES;

function parseHeartbeatMinutes(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed >= 1
    ? Math.min(parsed, 1440)
    : DEFAULT_HEARTBEAT_AFTER_MINUTES;
}

export function AgentContextSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("agentContextTitle"));
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const [instructions, setInstructions] = useState("");
  const [heartbeatTurnsAfterMinutes, setHeartbeatTurnsAfterMinutes] = useState(
    String(DEFAULT_HEARTBEAT_AFTER_MINUTES),
  );
  const [heartbeatTurnText, setHeartbeatTurnText] = useState(
    DEFAULT_HEARTBEAT_TEXT,
  );
  const [latexMathRendering, setLatexMathRendering] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // True once the form mirrors loaded settings; gates the undo baseline so
  // it snapshots the open-time values, not the pre-load defaults.
  const [formSynced, setFormSynced] = useState(false);

  useEffect(() => {
    if (settings) {
      setInstructions(settings.globalInstructions ?? "");
      setHeartbeatTurnsAfterMinutes(
        String(
          settings.heartbeatTurnsAfterMinutes ??
            DEFAULT_HEARTBEAT_AFTER_MINUTES,
        ),
      );
      setHeartbeatTurnText(
        settings.heartbeatTurnText ?? DEFAULT_HEARTBEAT_TEXT,
      );
      setLatexMathRendering(
        settings.agentContextHints?.latexMathRendering ?? false,
      );
      setFormSynced(true);
    }
  }, [settings]);

  const serverInstructions = settings?.globalInstructions ?? "";
  const serverHeartbeatTurnsAfterMinutes =
    settings?.heartbeatTurnsAfterMinutes ?? DEFAULT_HEARTBEAT_AFTER_MINUTES;
  const serverHeartbeatTurnText =
    settings?.heartbeatTurnText ?? DEFAULT_HEARTBEAT_TEXT;
  const serverLatexMathRendering =
    settings?.agentContextHints?.latexMathRendering ?? false;
  const effectiveAgentContext = useMemo(
    () =>
      buildEffectiveAgentContext({
        globalInstructions: instructions,
        hints: { latexMathRendering },
      }),
    [instructions, latexMathRendering],
  );

  // Header undo covers shown form values (saved or not), back to open-time.
  const undoState = useMemo(
    () =>
      formSynced
        ? {
            instructions,
            heartbeatTurnsAfterMinutes,
            heartbeatTurnText,
            latexMathRendering,
          }
        : null,
    [
      formSynced,
      instructions,
      heartbeatTurnsAfterMinutes,
      heartbeatTurnText,
      latexMathRendering,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: NonNullable<typeof undoState>) => {
      setInstructions(snapshot.instructions);
      setHeartbeatTurnsAfterMinutes(snapshot.heartbeatTurnsAfterMinutes);
      setHeartbeatTurnText(snapshot.heartbeatTurnText);
      setLatexMathRendering(snapshot.latexMathRendering);
      setHasChanges(false);
      setSaveError(null);
      void updateSettings({
        globalInstructions: snapshot.instructions.trim() || undefined,
        heartbeatTurnsAfterMinutes: parseHeartbeatMinutes(
          snapshot.heartbeatTurnsAfterMinutes,
        ),
        heartbeatTurnText:
          snapshot.heartbeatTurnText.trim() || DEFAULT_HEARTBEAT_TEXT,
        agentContextHints: {
          latexMathRendering: snapshot.latexMathRendering,
        },
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [updateSettings],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const recomputeHasChanges = useCallback(
    (next: {
      instructions?: string;
      heartbeatTurnsAfterMinutes?: string;
      heartbeatTurnText?: string;
      latexMathRendering?: boolean;
    }) => {
      const nextInstructions = next.instructions ?? instructions;
      const nextHeartbeatTurnsAfterMinutes =
        next.heartbeatTurnsAfterMinutes ?? heartbeatTurnsAfterMinutes;
      const nextHeartbeatTurnText = next.heartbeatTurnText ?? heartbeatTurnText;
      const nextLatexMathRendering =
        next.latexMathRendering ?? latexMathRendering;
      setHasChanges(
        nextInstructions !== serverInstructions ||
          nextHeartbeatTurnsAfterMinutes !==
            String(serverHeartbeatTurnsAfterMinutes) ||
          nextHeartbeatTurnText !== serverHeartbeatTurnText ||
          nextLatexMathRendering !== serverLatexMathRendering,
      );
    },
    [
      heartbeatTurnText,
      heartbeatTurnsAfterMinutes,
      instructions,
      latexMathRendering,
      serverHeartbeatTurnText,
      serverHeartbeatTurnsAfterMinutes,
      serverInstructions,
      serverLatexMathRendering,
    ],
  );

  const handleSave = useCallback(async () => {
    setIsSaving(true);
    setSaveError(null);
    try {
      await updateSettings({
        globalInstructions: instructions.trim() || undefined,
        heartbeatTurnsAfterMinutes: parseHeartbeatMinutes(
          heartbeatTurnsAfterMinutes,
        ),
        heartbeatTurnText: heartbeatTurnText.trim() || DEFAULT_HEARTBEAT_TEXT,
        agentContextHints: { latexMathRendering },
      });
      setHasChanges(false);
    } catch (err) {
      setSaveError(
        err instanceof Error ? err.message : t("agentContextSaveFailed"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    heartbeatTurnText,
    heartbeatTurnsAfterMinutes,
    instructions,
    latexMathRendering,
    t,
    updateSettings,
  ]);

  if (isLoading) {
    return <SettingsSection description={t("agentContextLoading")} />;
  }

  return (
    <SettingsSection description={t("agentContextDescription")}>
      <HideInSettingsSearch>
        <div className="settings-group">
          <div
            className="settings-item"
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <div className="settings-item-info">
              <strong>{t("agentContextGlobalInstructions")}</strong>
              <p>{t("agentContextGlobalInstructionsDescription")}</p>
            </div>
            <textarea
              className="settings-textarea"
              value={instructions}
              onChange={(e) => {
                const value = e.target.value.slice(0, MAX_LENGTH);
                setInstructions(value);
                recomputeHasChanges({ instructions: value });
                setSaveError(null);
              }}
              placeholder={t("agentContextPlaceholder")}
              rows={10}
            />
            <div
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                marginTop: "var(--space-2)",
              }}
            >
              <span className="settings-hint">
                {t("agentContextCharacters", {
                  current: instructions.length.toLocaleString(),
                  max: MAX_LENGTH.toLocaleString(),
                })}
              </span>
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

          <div className="settings-subsection-heading">
            <strong>{t("agentContextSuggestedHintsTitle")}</strong>
            <p>{t("agentContextSuggestedHintsDescription")}</p>
          </div>

          <label className="settings-item">
            <div className="settings-item-info">
              <strong>{t("agentContextSuggestedLatexTitle")}</strong>
              <p>{t("agentContextSuggestedLatexDescription")}</p>
            </div>
            <input
              type="checkbox"
              checked={latexMathRendering}
              onChange={(e) => {
                const nextLatexMathRendering = e.target.checked;
                setLatexMathRendering(nextLatexMathRendering);
                recomputeHasChanges({
                  latexMathRendering: nextLatexMathRendering,
                });
                setSaveError(null);
              }}
              aria-label={t("agentContextSuggestedLatexTitle")}
            />
          </label>

          <div
            className="settings-item"
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <div className="settings-item-info">
              <strong>{t("agentContextSuggestedLatexPreviewTitle")}</strong>
              <p>{t("agentContextSuggestedLatexPreviewDescription")}</p>
            </div>
            <pre className="settings-command-preview">
              {`[Client capabilities]\n${LATEX_MATH_RENDERING_CLIENT_CAPABILITY}`}
            </pre>
          </div>

          <details>
            <summary className="settings-hint">
              {t("agentContextPreviewSummary")}
            </summary>
            <pre className="settings-command-preview">
              {effectiveAgentContext ?? t("agentContextPreviewEmpty")}
            </pre>
          </details>
        </div>
      </HideInSettingsSearch>

      <div className="settings-group">
        <SettingsItem
          label={t("agentContextHeartbeatAfterTitle")}
          description={t("agentContextHeartbeatAfterDescription")}
        >
          <input
            type="number"
            className="settings-input-small"
            min={1}
            max={1440}
            value={heartbeatTurnsAfterMinutes}
            onChange={(e) => {
              setHeartbeatTurnsAfterMinutes(e.target.value);
              recomputeHasChanges({
                heartbeatTurnsAfterMinutes: e.target.value,
              });
              setSaveError(null);
            }}
          />
        </SettingsItem>

        <HideInSettingsSearch>
          <div
            className="settings-item"
            style={{ flexDirection: "column", alignItems: "stretch" }}
          >
            <div className="settings-item-info">
              <strong>{t("agentContextHeartbeatTextTitle")}</strong>
              <p>{t("agentContextHeartbeatTextDescription")}</p>
            </div>
            <HeartbeatTextArea
              className="settings-input"
              value={heartbeatTurnText}
              onChange={(value) => {
                setHeartbeatTurnText(value);
                recomputeHasChanges({
                  heartbeatTurnText: value,
                });
                setSaveError(null);
              }}
              placeholder={DEFAULT_HEARTBEAT_TEXT}
            />
          </div>
        </HideInSettingsSearch>
      </div>

      <HideInSettingsSearch>
        {(saveError || error) && (
          <p className="settings-warning">{saveError || error}</p>
        )}
      </HideInSettingsSearch>
    </SettingsSection>
  );
}
