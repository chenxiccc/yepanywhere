import {
  type BusyComposerDefaultAction,
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  MAX_PROJECT_QUEUE_QUIET_SECONDS,
  clampProjectQueueQuietSeconds,
} from "@yep-anywhere/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import { serverSupportsBangCommands } from "../../lib/bangCommandAvailability";
import { serverSupportsProjectQueue } from "../../lib/projectQueueVisibility";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndo } from "./SettingsUndoContext";

const BUSY_COMPOSER_DEFAULT_ACTIONS: BusyComposerDefaultAction[] = [
  "steer",
  "queue",
];

type TurnTimestampsPlacement = "off" | "before" | "after";

const TURN_TIMESTAMPS_PLACEMENTS: TurnTimestampsPlacement[] = [
  "off",
  "before",
  "after",
];

const JOIN_WINDOW_SLIDER_MAX_SECONDS = 120;
const JOIN_WINDOW_MAX_SECONDS = 86400;
const SECONDS_SLIDER_SAVE_DEBOUNCE_MS = 400;

function parseJoinWindowSeconds(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(parsed, JOIN_WINDOW_MAX_SECONDS);
}

function parseProjectQueueQuietSeconds(value: string): number {
  const parsed = Number.parseInt(value, 10);
  return (
    clampProjectQueueQuietSeconds(parsed) ?? DEFAULT_PROJECT_QUEUE_QUIET_SECONDS
  );
}

interface MessageDeliveryBaseline {
  joinWindowSeconds: number;
  projectQueueQuietSeconds: number;
  composeAnchorsEnabled: boolean;
  turnTimestamps: TurnTimestampsPlacement;
  bangCommandsEnabled: boolean;
  busyComposerDefaultAction: BusyComposerDefaultAction;
  steerNowDefault: boolean;
  patientQueueDefault: boolean;
  projectQueueCtrlEnterEnabled: boolean;
}

/**
 * Message Delivery pane. Settings apply immediately on change (the house
 * style for toggle/slider panes — no Save button); the header-row Undo
 * (useSettingsUndo) reverts to the values from when the pane was opened.
 */
export function MessageDeliverySettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("messageDeliveryTitle"));
  const { settings, isLoading, error, updateSettings } = useServerSettings();
  const { version } = useVersion();
  const supportsProjectQueue = serverSupportsProjectQueue(version);
  const supportsBangCommands = serverSupportsBangCommands(version);

  // null drafts mirror the server value; non-null while the user is editing
  // or a save is in flight, cleared once the server catches up.
  const [draftJoinWindow, setDraftJoinWindow] = useState<string | null>(null);
  const [draftProjectQueueQuiet, setDraftProjectQueueQuiet] = useState<
    string | null
  >(null);
  const [draftAnchors, setDraftAnchors] = useState<boolean | null>(null);
  const [draftTurnTimestamps, setDraftTurnTimestamps] =
    useState<TurnTimestampsPlacement | null>(null);
  const [draftBangCommands, setDraftBangCommands] = useState<boolean | null>(
    null,
  );
  const [draftBusyDefaultAction, setDraftBusyDefaultAction] =
    useState<BusyComposerDefaultAction | null>(null);
  const [draftSteerNow, setDraftSteerNow] = useState<boolean | null>(null);
  const [draftPatientQueue, setDraftPatientQueue] = useState<boolean | null>(
    null,
  );
  const [draftProjectQueueCtrlEnter, setDraftProjectQueueCtrlEnter] = useState<
    boolean | null
  >(null);
  const baselineRef = useRef<MessageDeliveryBaseline | null>(null);

  const serverJoinWindowSeconds = settings?.deferredJoinWindowSeconds ?? 0;
  const serverProjectQueueQuietSeconds =
    clampProjectQueueQuietSeconds(settings?.projectQueueQuietSeconds) ??
    DEFAULT_PROJECT_QUEUE_QUIET_SECONDS;
  const serverComposeAnchorsEnabled = settings?.composeAnchorsEnabled ?? false;
  const serverTurnTimestamps = settings?.turnTimestamps ?? "off";
  const serverBangCommandsEnabled =
    settings?.clientDefaults?.bangCommandsEnabled ?? false;
  const serverBusyDefaultAction =
    settings?.clientDefaults?.busyComposerDefaultAction ?? "steer";
  const serverSteerNowDefault =
    settings?.clientDefaults?.steerNowDefault ?? false;
  const serverPatientQueueDefault =
    settings?.clientDefaults?.patientQueueDefault ?? false;
  const serverProjectQueueCtrlEnterEnabled =
    settings?.clientDefaults?.projectQueueCtrlEnterEnabled ??
    DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED;

  useEffect(() => {
    if (settings && !baselineRef.current) {
      baselineRef.current = {
        joinWindowSeconds: settings.deferredJoinWindowSeconds ?? 0,
        projectQueueQuietSeconds:
          clampProjectQueueQuietSeconds(settings.projectQueueQuietSeconds) ??
          DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
        composeAnchorsEnabled: settings.composeAnchorsEnabled ?? false,
        turnTimestamps: settings.turnTimestamps ?? "off",
        bangCommandsEnabled:
          settings.clientDefaults?.bangCommandsEnabled ?? false,
        busyComposerDefaultAction:
          settings.clientDefaults?.busyComposerDefaultAction ?? "steer",
        steerNowDefault: settings.clientDefaults?.steerNowDefault ?? false,
        patientQueueDefault:
          settings.clientDefaults?.patientQueueDefault ?? false,
        projectQueueCtrlEnterEnabled:
          settings.clientDefaults?.projectQueueCtrlEnterEnabled ??
          DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
      };
    }
  }, [settings]);

  const shownJoinWindowText =
    draftJoinWindow ?? String(serverJoinWindowSeconds);
  const shownJoinWindowSeconds = parseJoinWindowSeconds(shownJoinWindowText);
  const shownProjectQueueQuietText =
    draftProjectQueueQuiet ?? String(serverProjectQueueQuietSeconds);
  const shownProjectQueueQuietSeconds = parseProjectQueueQuietSeconds(
    shownProjectQueueQuietText,
  );
  const shownAnchors = draftAnchors ?? serverComposeAnchorsEnabled;
  const shownTurnTimestamps = draftTurnTimestamps ?? serverTurnTimestamps;
  const shownBangCommands = draftBangCommands ?? serverBangCommandsEnabled;
  const shownBusyDefaultAction =
    draftBusyDefaultAction ?? serverBusyDefaultAction;
  const shownSteerNowDefault = draftSteerNow ?? serverSteerNowDefault;
  const shownPatientQueueDefault =
    draftPatientQueue ?? serverPatientQueueDefault;
  const shownProjectQueueCtrlEnter =
    draftProjectQueueCtrlEnter ?? serverProjectQueueCtrlEnterEnabled;

  // Debounced auto-save for the join window (sliders fire continuously).
  useEffect(() => {
    if (draftJoinWindow === null) return;
    const parsed = parseJoinWindowSeconds(draftJoinWindow);
    if (parsed === serverJoinWindowSeconds) return;
    const timer = setTimeout(() => {
      void updateSettings({ deferredJoinWindowSeconds: parsed }).catch(() => {
        // surfaced via the hook's error state
      });
    }, SECONDS_SLIDER_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draftJoinWindow, serverJoinWindowSeconds, updateSettings]);

  useEffect(() => {
    if (!supportsProjectQueue) return;
    if (draftProjectQueueQuiet === null) return;
    const parsed = parseProjectQueueQuietSeconds(draftProjectQueueQuiet);
    if (parsed === serverProjectQueueQuietSeconds) return;
    const timer = setTimeout(() => {
      void updateSettings({ projectQueueQuietSeconds: parsed }).catch(() => {
        // surfaced via the hook's error state
      });
    }, SECONDS_SLIDER_SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [
    draftProjectQueueQuiet,
    serverProjectQueueQuietSeconds,
    supportsProjectQueue,
    updateSettings,
  ]);

  // Drop drafts once the server reflects them.
  useEffect(() => {
    if (
      draftJoinWindow !== null &&
      parseJoinWindowSeconds(draftJoinWindow) === serverJoinWindowSeconds
    ) {
      setDraftJoinWindow(null);
    }
  }, [draftJoinWindow, serverJoinWindowSeconds]);
  useEffect(() => {
    if (
      draftProjectQueueQuiet !== null &&
      parseProjectQueueQuietSeconds(draftProjectQueueQuiet) ===
        serverProjectQueueQuietSeconds
    ) {
      setDraftProjectQueueQuiet(null);
    }
  }, [draftProjectQueueQuiet, serverProjectQueueQuietSeconds]);
  useEffect(() => {
    if (draftAnchors !== null && draftAnchors === serverComposeAnchorsEnabled) {
      setDraftAnchors(null);
    }
  }, [draftAnchors, serverComposeAnchorsEnabled]);
  useEffect(() => {
    if (
      draftTurnTimestamps !== null &&
      draftTurnTimestamps === serverTurnTimestamps
    ) {
      setDraftTurnTimestamps(null);
    }
  }, [draftTurnTimestamps, serverTurnTimestamps]);
  useEffect(() => {
    if (
      draftBangCommands !== null &&
      draftBangCommands === serverBangCommandsEnabled
    ) {
      setDraftBangCommands(null);
    }
  }, [draftBangCommands, serverBangCommandsEnabled]);
  useEffect(() => {
    if (
      draftBusyDefaultAction !== null &&
      draftBusyDefaultAction === serverBusyDefaultAction
    ) {
      setDraftBusyDefaultAction(null);
    }
  }, [draftBusyDefaultAction, serverBusyDefaultAction]);
  useEffect(() => {
    if (draftSteerNow !== null && draftSteerNow === serverSteerNowDefault) {
      setDraftSteerNow(null);
    }
  }, [draftSteerNow, serverSteerNowDefault]);
  useEffect(() => {
    if (
      draftPatientQueue !== null &&
      draftPatientQueue === serverPatientQueueDefault
    ) {
      setDraftPatientQueue(null);
    }
  }, [draftPatientQueue, serverPatientQueueDefault]);
  useEffect(() => {
    if (
      draftProjectQueueCtrlEnter !== null &&
      draftProjectQueueCtrlEnter === serverProjectQueueCtrlEnterEnabled
    ) {
      setDraftProjectQueueCtrlEnter(null);
    }
  }, [draftProjectQueueCtrlEnter, serverProjectQueueCtrlEnterEnabled]);

  const baseline = baselineRef.current;
  const canUndo =
    !!baseline &&
    (shownJoinWindowSeconds !== baseline.joinWindowSeconds ||
      (supportsProjectQueue &&
        shownProjectQueueQuietSeconds !== baseline.projectQueueQuietSeconds) ||
      shownAnchors !== baseline.composeAnchorsEnabled ||
      shownTurnTimestamps !== baseline.turnTimestamps ||
      (supportsBangCommands &&
        shownBangCommands !== baseline.bangCommandsEnabled) ||
      shownBusyDefaultAction !== baseline.busyComposerDefaultAction ||
      shownSteerNowDefault !== baseline.steerNowDefault ||
      shownPatientQueueDefault !== baseline.patientQueueDefault ||
      (supportsProjectQueue &&
        shownProjectQueueCtrlEnter !== baseline.projectQueueCtrlEnterEnabled));

  const undo = useCallback(async () => {
    const snapshot = baselineRef.current;
    if (!snapshot) return;
    setDraftJoinWindow(null);
    setDraftProjectQueueQuiet(null);
    setDraftAnchors(null);
    setDraftTurnTimestamps(null);
    setDraftBangCommands(null);
    setDraftBusyDefaultAction(null);
    setDraftSteerNow(null);
    setDraftPatientQueue(null);
    setDraftProjectQueueCtrlEnter(null);
    await updateSettings({
      deferredJoinWindowSeconds: snapshot.joinWindowSeconds,
      ...(supportsProjectQueue
        ? { projectQueueQuietSeconds: snapshot.projectQueueQuietSeconds }
        : {}),
      composeAnchorsEnabled: snapshot.composeAnchorsEnabled,
      turnTimestamps: snapshot.turnTimestamps,
      clientDefaults: {
        ...(supportsBangCommands
          ? { bangCommandsEnabled: snapshot.bangCommandsEnabled }
          : {}),
        busyComposerDefaultAction: snapshot.busyComposerDefaultAction,
        steerNowDefault: snapshot.steerNowDefault,
        patientQueueDefault: snapshot.patientQueueDefault,
        ...(supportsProjectQueue
          ? {
              projectQueueCtrlEnterEnabled:
                snapshot.projectQueueCtrlEnterEnabled,
            }
          : {}),
      },
    }).catch(() => {
      // surfaced via the hook's error state
    });
  }, [supportsBangCommands, supportsProjectQueue, updateSettings]);

  useSettingsUndo(canUndo, undo);

  if (isLoading) {
    return <SettingsSection description={t("messageDeliveryLoading")} />;
  }

  return (
    <SettingsSection description={t("messageDeliveryDescription")}>
      <div className="settings-group">
        <SettingsItem
          label={t("messageDeliveryJoinWindowTitle")}
          description={t("messageDeliveryJoinWindowDescription")}
          valueText={shownJoinWindowText}
          className="model-settings-item"
        >
          <span className="output-appearance-slider-row">
            <CommittedRangeInput
              id="message-delivery-join-window"
              min={0}
              max={JOIN_WINDOW_SLIDER_MAX_SECONDS}
              step={5}
              value={Math.min(
                shownJoinWindowSeconds,
                JOIN_WINDOW_SLIDER_MAX_SECONDS,
              )}
              aria-label={t("messageDeliveryJoinWindowTitle")}
              onCommit={(value) => setDraftJoinWindow(String(value))}
            />
            <span className="output-appearance-number-wrap">
              <input
                type="number"
                className="settings-input-small output-appearance-number"
                min={0}
                max={JOIN_WINDOW_MAX_SECONDS}
                value={shownJoinWindowText}
                onChange={(e) => setDraftJoinWindow(e.target.value)}
                aria-label={t("messageDeliveryJoinWindowTitle")}
              />
              <span className="output-appearance-unit">s</span>
            </span>
          </span>
          <span className="settings-hint">
            {shownJoinWindowSeconds === 0
              ? t("messageDeliveryJoinWindowOffHint")
              : t("messageDeliveryJoinWindowOnHint", {
                  seconds: String(shownJoinWindowSeconds),
                })}
          </span>
        </SettingsItem>

        {supportsProjectQueue && (
          <SettingsItem
            label={t("messageDeliveryProjectQueueQuietTitle")}
            description={t("messageDeliveryProjectQueueQuietDescription")}
            valueText={shownProjectQueueQuietText}
            className="model-settings-item"
          >
            <span className="output-appearance-slider-row">
              <CommittedRangeInput
                id="message-delivery-project-queue-quiet"
                min={0}
                max={MAX_PROJECT_QUEUE_QUIET_SECONDS}
                step={5}
                value={shownProjectQueueQuietSeconds}
                aria-label={t("messageDeliveryProjectQueueQuietTitle")}
                onCommit={(value) => setDraftProjectQueueQuiet(String(value))}
              />
              <span className="output-appearance-number-wrap">
                <input
                  type="number"
                  className="settings-input-small output-appearance-number"
                  min={0}
                  max={MAX_PROJECT_QUEUE_QUIET_SECONDS}
                  value={shownProjectQueueQuietText}
                  onChange={(e) => setDraftProjectQueueQuiet(e.target.value)}
                  aria-label={t("messageDeliveryProjectQueueQuietTitle")}
                />
                <span className="output-appearance-unit">s</span>
              </span>
            </span>
            <span className="settings-hint">
              {shownProjectQueueQuietSeconds === 0
                ? t("messageDeliveryProjectQueueQuietOffHint")
                : t("messageDeliveryProjectQueueQuietOnHint", {
                    seconds: String(shownProjectQueueQuietSeconds),
                  })}
            </span>
          </SettingsItem>
        )}

        <SettingsItem
          as="label"
          label={t("messageDeliveryComposeAnchorsTitle")}
          description={t("messageDeliveryComposeAnchorsDescription")}
        >
          <input
            type="checkbox"
            checked={shownAnchors}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftAnchors(next);
              void updateSettings({ composeAnchorsEnabled: next }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliveryComposeAnchorsTitle")}
          />
        </SettingsItem>

        <SettingsItem
          label={t("messageDeliveryTurnTimestampsTitle")}
          description={t("messageDeliveryTurnTimestampsDescription")}
        >
          <select
            className="settings-select"
            value={shownTurnTimestamps}
            onChange={(event) => {
              const next = event.target.value as TurnTimestampsPlacement;
              if (!TURN_TIMESTAMPS_PLACEMENTS.includes(next)) return;
              setDraftTurnTimestamps(next);
              void updateSettings({ turnTimestamps: next }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliveryTurnTimestampsTitle")}
          >
            <option value="off">{t("messageDeliveryTurnTimestampsOff")}</option>
            <option value="before">
              {t("messageDeliveryTurnTimestampsBefore")}
            </option>
            <option value="after">
              {t("messageDeliveryTurnTimestampsAfter")}
            </option>
          </select>
        </SettingsItem>

        {supportsBangCommands && (
          <SettingsItem
            as="label"
            label={t("messageDeliveryBangCommandsTitle")}
            description={t("messageDeliveryBangCommandsDescription")}
          >
            <input
              type="checkbox"
              checked={shownBangCommands}
              onChange={(e) => {
                const next = e.target.checked;
                setDraftBangCommands(next);
                void updateSettings({
                  clientDefaults: { bangCommandsEnabled: next },
                }).catch(() => {
                  // surfaced via the hook's error state
                });
              }}
              aria-label={t("messageDeliveryBangCommandsTitle")}
            />
          </SettingsItem>
        )}

        <SettingsItem
          label={t("appearanceToolbarDefaultActionTitle")}
          description={t("appearanceToolbarDefaultActionDescription")}
        >
          <select
            className="settings-select"
            value={shownBusyDefaultAction}
            onChange={(event) => {
              const next = event.target.value as BusyComposerDefaultAction;
              if (!BUSY_COMPOSER_DEFAULT_ACTIONS.includes(next)) return;
              setDraftBusyDefaultAction(next);
              void updateSettings({
                clientDefaults: { busyComposerDefaultAction: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("appearanceToolbarDefaultActionTitle")}
          >
            <option value="steer">
              {t("appearanceToolbarDefaultActionSteer")}
            </option>
            <option value="queue">
              {t("appearanceToolbarDefaultActionQueue")}
            </option>
          </select>
        </SettingsItem>

        <SettingsItem
          as="label"
          label={t("messageDeliverySteerNowDefaultTitle")}
          description={t("messageDeliverySteerNowDefaultDescription")}
        >
          <input
            type="checkbox"
            checked={shownSteerNowDefault}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftSteerNow(next);
              void updateSettings({
                clientDefaults: { steerNowDefault: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliverySteerNowDefaultTitle")}
          />
        </SettingsItem>

        <SettingsItem
          as="label"
          label={t("messageDeliveryPatientQueueDefaultTitle")}
          description={t("messageDeliveryPatientQueueDefaultDescription")}
        >
          <input
            type="checkbox"
            checked={shownPatientQueueDefault}
            onChange={(e) => {
              const next = e.target.checked;
              setDraftPatientQueue(next);
              void updateSettings({
                clientDefaults: { patientQueueDefault: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("messageDeliveryPatientQueueDefaultTitle")}
          />
        </SettingsItem>

        {supportsProjectQueue && (
          <SettingsItem
            as="label"
            label={t("messageDeliveryProjectQueueShortcutTitle")}
            description={t("messageDeliveryProjectQueueShortcutDescription")}
          >
            <input
              type="checkbox"
              checked={shownProjectQueueCtrlEnter}
              onChange={(e) => {
                const next = e.target.checked;
                setDraftProjectQueueCtrlEnter(next);
                void updateSettings({
                  clientDefaults: { projectQueueCtrlEnterEnabled: next },
                }).catch(() => {
                  // surfaced via the hook's error state
                });
              }}
              aria-label={t("messageDeliveryProjectQueueShortcutTitle")}
            />
          </SettingsItem>
        )}

        {error && <p className="settings-warning">{error}</p>}
      </div>
    </SettingsSection>
  );
}
