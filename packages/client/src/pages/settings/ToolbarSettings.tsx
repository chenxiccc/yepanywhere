import type {
  BusyComposerDefaultAction,
  CollapsedComposerButtonPreference,
  ToolbarControlPresence,
  ToolbarNarrowingPriority,
} from "@yep-anywhere/shared";
import { useCallback, useMemo, useState } from "react";
import {
  SessionToolbarPreview,
  ToolbarControlPreview,
} from "../../components/SessionToolbarPreview";
import { CommittedRangeInput } from "../../components/ui/CommittedRangeInput";
import { CommittedRangeNumberInput } from "../../components/ui/CommittedRangeNumberInput";
import {
  CONVERSATION_VIEW_TURN_LIMIT_STEP,
  MAX_CONVERSATION_VIEW_TURN_LIMIT,
  MIN_CONVERSATION_VIEW_TURN_LIMIT,
  useConversationViewTurnLimit,
} from "../../hooks/useConversationView";
import {
  type SessionToolbarVisibilityKey,
  useSessionToolbarPresence,
} from "../../hooks/useSessionToolbarPresence";
import { useServerSettings } from "../../hooks/useServerSettings";
import { useVersion } from "../../hooks/useVersion";
import { useI18n } from "../../i18n";
import {
  serverSupportsProjectQueue,
  serverSupportsProjectQueueNewSessionShortcutSetting,
} from "../../lib/projectQueueVisibility";
import { SettingsItem } from "./SettingsItem";
import { useSettingsPaneTitle } from "./SettingsPaneTitleContext";
import { HideInSettingsSearch } from "./SettingsSearchContext";
import { SettingsSection } from "./SettingsSection";
import { useSettingsUndoBaseline } from "./SettingsUndoContext";

const BUSY_COMPOSER_DEFAULT_ACTIONS: BusyComposerDefaultAction[] = [
  "steer",
  "queue",
];

const COLLAPSED_COMPOSER_BUTTON_OPTIONS: CollapsedComposerButtonPreference[] = [
  "primary",
  "alternate",
  "microphone",
];

type ToolbarSide = "left" | "right";

interface ToolbarControlMeta {
  key: SessionToolbarVisibilityKey;
  title: string;
  description: string;
  side: ToolbarSide;
  canSetPriority: boolean;
  /**
   * Whether the control has a toolbar rendering to preview. Controls that only
   * appear elsewhere in the composer would render an empty preview tile, so
   * they get the copy and slider alone.
   */
  hasToolbarPreview: boolean;
}

/** Presence-configurable controls that never render on the toolbar itself. */
const NON_TOOLBAR_CONTROLS = new Set<SessionToolbarVisibilityKey>([
  "composerRecall",
]);

const PRIORITY_EDITABLE_CONTROLS = new Set<SessionToolbarVisibilityKey>([
  "modeSelector",
  "attachments",
  "slashMenu",
  "thinkingToggle",
  "renderMode",
  "conversationView",
  "nudge",
  "sessionStatus",
  "shortcutsHelp",
  "contextUsage",
  "btw",
  "steerNow",
  "projectQueue",
  "projectQueueNewSessionShortcut",
]);

// Presence-slider notch order above the Hide notch (0): rightward notches
// survive narrowing longer, ending at "show always" (pin).
const PRESENCE_SLIDER_PRIORITIES: readonly ToolbarNarrowingPriority[] = [
  "first",
  "mid",
  "last",
  "pin",
];

function presenceSliderId(key: SessionToolbarVisibilityKey): string {
  return `session-toolbar-presence-${key}`;
}

function presenceCaptionKey(canSetPriority: boolean, notch: number) {
  if (notch <= 0) return "appearanceToolbarPresenceHiddenCaption" as const;
  if (!canSetPriority) return "appearanceToolbarPresenceShownCaption" as const;
  switch (PRESENCE_SLIDER_PRIORITIES[notch - 1]) {
    case "first":
      return "appearanceToolbarPresenceFirstCaption" as const;
    case "mid":
      return "appearanceToolbarPresenceMidCaption" as const;
    case "last":
      return "appearanceToolbarPresenceLastCaption" as const;
    default:
      return "appearanceToolbarPresencePinCaption" as const;
  }
}

interface ControlPresenceSliderProps {
  control: ToolbarControlMeta;
  presence: ToolbarControlPresence;
  onCommitNotch: (control: ToolbarControlMeta, notch: number) => void;
}

// One slider per control editing its single presence value: hidden or a
// narrowing-priority tier. Controls outside the overflow engine get only the
// two end notches, since first/mid/last would not map to real runtime
// behavior.
function ControlPresenceSlider({
  control,
  presence,
  onCommitNotch,
}: ControlPresenceSliderProps) {
  const { t } = useI18n();
  const [draftNotch, setDraftNotch] = useState<number | null>(null);
  const max = control.canSetPriority ? PRESENCE_SLIDER_PRIORITIES.length : 1;
  const notch =
    presence === "hidden"
      ? 0
      : control.canSetPriority
        ? 1 + Math.max(0, PRESENCE_SLIDER_PRIORITIES.indexOf(presence))
        : 1;
  const shownNotch = draftNotch ?? notch;
  const caption = t(presenceCaptionKey(control.canSetPriority, shownNotch));
  const inputId = presenceSliderId(control.key);
  const captionId = `${inputId}-caption`;
  const clearDraft = () => setDraftNotch(null);
  return (
    <span className="session-toolbar-presence">
      <CommittedRangeInput
        id={inputId}
        className="session-toolbar-presence-range"
        min={0}
        max={max}
        step={1}
        value={notch}
        onDraftChange={setDraftNotch}
        onCommit={(next) => {
          setDraftNotch(null);
          onCommitNotch(control, next);
        }}
        onBlur={clearDraft}
        onKeyUp={clearDraft}
        onPointerUp={clearDraft}
        onPointerCancel={clearDraft}
        aria-label={t("appearanceToolbarPresenceAria", {
          control: control.title,
        })}
        aria-valuetext={caption}
        aria-describedby={captionId}
      />
      <span className="session-toolbar-presence-ticks" aria-hidden="true">
        {Array.from({ length: max + 1 }, (_, tick) => (
          <span
            key={tick}
            className={`session-toolbar-presence-tick${
              tick <= shownNotch ? " is-reached" : ""
            }`}
          />
        ))}
      </span>
      <span className="session-toolbar-presence-labels" aria-hidden="true">
        <span>{t("appearanceToolbarHide")}</span>
        <span>{t("appearanceToolbarShowAlways")}</span>
      </span>
      <span className="session-toolbar-presence-caption" id={captionId}>
        {caption}
      </span>
    </span>
  );
}

export function ToolbarSettings() {
  const { t } = useI18n();
  useSettingsPaneTitle(t("appearanceSessionToolbarTitle"));
  const {
    presence: toolbarPresence,
    setControlPresence,
    resetPresence,
  } = useSessionToolbarPresence();
  const [placementPresence] = useState(() => ({ ...toolbarPresence }));
  const { settings, error, updateSettings } = useServerSettings();
  const { version } = useVersion();
  const { conversationViewTurnLimit, setConversationViewTurnLimit } =
    useConversationViewTurnLimit();
  const supportsProjectQueue = serverSupportsProjectQueue(version);
  const supportsProjectQueueNewSessionShortcutSetting =
    serverSupportsProjectQueueNewSessionShortcutSetting(version);

  const busyComposerDefaultAction =
    settings?.clientDefaults?.busyComposerDefaultAction ?? "steer";
  const collapsedComposerButton =
    settings?.clientDefaults?.collapsedComposerButton ?? "primary";

  const undoState = useMemo(
    () =>
      settings
        ? {
            toolbarPresence,
            busyComposerDefaultAction,
            collapsedComposerButton,
            conversationViewTurnLimit,
          }
        : null,
    [
      busyComposerDefaultAction,
      collapsedComposerButton,
      conversationViewTurnLimit,
      settings,
      toolbarPresence,
    ],
  );
  const restoreUndoState = useCallback(
    (snapshot: typeof undoState) => {
      if (!snapshot) return;
      for (const [key, value] of Object.entries(snapshot.toolbarPresence)) {
        setControlPresence(key as SessionToolbarVisibilityKey, value);
      }
      setConversationViewTurnLimit(snapshot.conversationViewTurnLimit);
      void updateSettings({
        clientDefaults: {
          busyComposerDefaultAction: snapshot.busyComposerDefaultAction,
          collapsedComposerButton: snapshot.collapsedComposerButton,
        },
      }).catch(() => {
        // surfaced via the hook's error state
      });
    },
    [setControlPresence, setConversationViewTurnLimit, updateSettings],
  );
  useSettingsUndoBaseline(undoState, restoreUndoState);

  const controlMeta = (
    key: SessionToolbarVisibilityKey,
    title: string,
    description: string,
    side: ToolbarSide,
  ): ToolbarControlMeta => ({
    key,
    title,
    description,
    side,
    canSetPriority: PRIORITY_EDITABLE_CONTROLS.has(key),
    hasToolbarPreview: !NON_TOOLBAR_CONTROLS.has(key),
  });

  const toolbarControls: ToolbarControlMeta[] = [
    controlMeta(
      "modeSelector",
      t("appearanceToolbarModeTitle"),
      t("appearanceToolbarModeDescription"),
      "left",
    ),
    controlMeta(
      "attachments",
      t("appearanceToolbarAttachmentsTitle"),
      t("appearanceToolbarAttachmentsDescription"),
      "left",
    ),
    controlMeta(
      "slashMenu",
      t("appearanceToolbarSlashTitle"),
      t("appearanceToolbarSlashDescription"),
      "left",
    ),
    controlMeta(
      "thinkingToggle",
      t("appearanceToolbarThinkingTitle"),
      t("appearanceToolbarThinkingDescription"),
      "left",
    ),
    controlMeta(
      "renderMode",
      t("appearanceToolbarRenderModeTitle"),
      t("appearanceToolbarRenderModeDescription"),
      "left",
    ),
    controlMeta(
      "conversationView",
      t("appearanceToolbarConversationViewTitle"),
      t("appearanceToolbarConversationViewDescription"),
      "left",
    ),
    controlMeta(
      "nudge",
      t("appearanceToolbarNudgeTitle"),
      t("appearanceToolbarNudgeDescription"),
      "left",
    ),
    controlMeta(
      "microphone",
      t("appearanceToolbarMicrophoneTitle"),
      t("appearanceToolbarMicrophoneDescription"),
      "left",
    ),
    controlMeta(
      "waveform",
      t("appearanceToolbarWaveformTitle"),
      t("appearanceToolbarWaveformDescription"),
      "left",
    ),
    controlMeta(
      "sessionStatus",
      t("appearanceToolbarStatusTitle"),
      t("appearanceToolbarStatusDescription"),
      "right",
    ),
    controlMeta(
      "shortcutsHelp",
      t("appearanceToolbarShortcutsTitle"),
      t("appearanceToolbarShortcutsDescription"),
      "right",
    ),
    controlMeta(
      "contextUsage",
      t("appearanceToolbarContextTitle"),
      t("appearanceToolbarContextDescription"),
      "right",
    ),
    controlMeta(
      "btw",
      t("appearanceToolbarBtwTitle"),
      t("appearanceToolbarBtwDescription"),
      "right",
    ),
    controlMeta(
      "steerNow",
      t("appearanceToolbarSteerNowTitle"),
      t("appearanceToolbarSteerNowDescription"),
      "right",
    ),
    controlMeta(
      "composerRecall",
      t("appearanceToolbarComposerRecallTitle"),
      t("appearanceToolbarComposerRecallDescription"),
      "right",
    ),
  ];
  if (supportsProjectQueue) {
    toolbarControls.push(
      controlMeta(
        "projectQueue",
        t("appearanceToolbarProjectQueueTitle"),
        t("appearanceToolbarProjectQueueDescription"),
        "right",
      ),
    );
  }
  if (supportsProjectQueueNewSessionShortcutSetting) {
    toolbarControls.push(
      controlMeta(
        "projectQueueNewSessionShortcut",
        t("appearanceToolbarProjectQueueNewSessionShortcutTitle"),
        t("appearanceToolbarProjectQueueNewSessionShortcutDescription"),
        "right",
      ),
    );
  }

  const hiddenLeft = toolbarControls.filter(
    (control) =>
      placementPresence[control.key] === "hidden" && control.side === "left",
  );
  const hiddenRight = toolbarControls.filter(
    (control) =>
      placementPresence[control.key] === "hidden" && control.side === "right",
  );
  const shownControls = toolbarControls.filter(
    (control) => placementPresence[control.key] !== "hidden",
  );

  const commitPresenceNotch = useCallback(
    (control: ToolbarControlMeta, notch: number) => {
      const next: ToolbarControlPresence =
        notch <= 0
          ? "hidden"
          : control.canSetPriority
            ? (PRESENCE_SLIDER_PRIORITIES[notch - 1] ?? "pin")
            : "pin";
      if (toolbarPresence[control.key] !== next) {
        setControlPresence(control.key, next);
      }
    },
    [setControlPresence, toolbarPresence],
  );

  const renderControlRow = (
    control: ToolbarControlMeta,
    placement: "hidden" | "shown",
  ) => (
    <div
      className={`session-toolbar-control-row is-${placement} ${
        toolbarPresence[control.key] === "hidden"
          ? "is-currently-hidden"
          : "is-currently-shown"
      }`}
      key={control.key}
    >
      {control.hasToolbarPreview && (
        <span className="session-toolbar-control-preview-cell">
          <ToolbarControlPreview
            activationLabel={t("appearanceToolbarActivateControl", {
              control: control.title,
            })}
            controlKey={control.key}
            onActivate={() => {
              document.getElementById(presenceSliderId(control.key))?.focus();
            }}
          />
        </span>
      )}
      <span className="session-toolbar-control-copy">
        <strong>{control.title}</strong>
        <span>{control.description}</span>
      </span>
      <span className="session-toolbar-control-actions">
        <ControlPresenceSlider
          control={control}
          presence={toolbarPresence[control.key]}
          onCommitNotch={commitPresenceNotch}
        />
      </span>
    </div>
  );

  const renderHiddenGroup = (label: string, controls: ToolbarControlMeta[]) => (
    <div className="session-toolbar-hidden-group">
      <div className="session-toolbar-hidden-group-title">{label}</div>
      {controls.length === 0 ? (
        <p className="session-toolbar-hidden-empty">
          {t("appearanceToolbarSideNoneHidden")}
        </p>
      ) : (
        controls.map((control) => renderControlRow(control, "hidden"))
      )}
    </div>
  );

  return (
    <SettingsSection description={t("appearanceSessionToolbarDescription")}>
      <div className="settings-group">
        <SettingsItem
          label={t("appearanceToolbarDefaultActionTitle")}
          description={t("appearanceToolbarDefaultActionDescription")}
        >
          <select
            className="settings-select"
            value={busyComposerDefaultAction}
            onChange={(event) => {
              const next = event.target.value as BusyComposerDefaultAction;
              if (!BUSY_COMPOSER_DEFAULT_ACTIONS.includes(next)) return;
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
          label={t("appearanceToolbarCollapsedButtonTitle")}
          description={t("appearanceToolbarCollapsedButtonDescription")}
        >
          <select
            className="settings-select"
            value={collapsedComposerButton}
            onChange={(event) => {
              const next = event.target
                .value as CollapsedComposerButtonPreference;
              if (!COLLAPSED_COMPOSER_BUTTON_OPTIONS.includes(next)) return;
              void updateSettings({
                clientDefaults: { collapsedComposerButton: next },
              }).catch(() => {
                // surfaced via the hook's error state
              });
            }}
            aria-label={t("appearanceToolbarCollapsedButtonTitle")}
          >
            <option value="primary">
              {t("appearanceToolbarCollapsedButtonPrimary")}
            </option>
            <option value="alternate">
              {t("appearanceToolbarCollapsedButtonAlternate")}
            </option>
            <option value="microphone">
              {t("appearanceToolbarCollapsedButtonMicrophone")}
            </option>
          </select>
        </SettingsItem>

        <SettingsItem
          label={t("appearanceToolbarConversationViewTurnLimitTitle")}
          description={t(
            "appearanceToolbarConversationViewTurnLimitDescription",
          )}
          className="settings-item--wide-control"
        >
          <CommittedRangeNumberInput
            id="conversation-view-turn-limit"
            min={MIN_CONVERSATION_VIEW_TURN_LIMIT}
            max={MAX_CONVERSATION_VIEW_TURN_LIMIT}
            step={CONVERSATION_VIEW_TURN_LIMIT_STEP}
            value={conversationViewTurnLimit}
            unit={t("appearanceToolbarConversationViewTurnLimitUnit")}
            ariaLabel={t("appearanceToolbarConversationViewTurnLimitTitle")}
            onCommit={setConversationViewTurnLimit}
          />
        </SettingsItem>

        <HideInSettingsSearch>
          <div className="settings-item session-toolbar-settings">
            <SessionToolbarPreview />

            <div className="session-toolbar-zone">
              <div className="session-toolbar-zone-heading">
                <strong>{t("appearanceToolbarHiddenHeading")}</strong>
                <span>{t("appearanceToolbarHiddenDescription")}</span>
              </div>
              <div className="session-toolbar-hidden-groups">
                {renderHiddenGroup(t("appearanceToolbarSideLeft"), hiddenLeft)}
                {renderHiddenGroup(
                  t("appearanceToolbarSideRight"),
                  hiddenRight,
                )}
              </div>
            </div>

            <div className="session-toolbar-zone-separator" />

            <div className="session-toolbar-zone">
              <div className="session-toolbar-zone-heading">
                <strong>{t("appearanceToolbarShownHeading")}</strong>
                <span>{t("appearanceToolbarShownDescription")}</span>
              </div>
              <div className="session-toolbar-control-list">
                {shownControls.map((control) =>
                  renderControlRow(control, "shown"),
                )}
              </div>
            </div>

            <div className="settings-item-actions">
              <button
                type="button"
                className="settings-button settings-button-secondary"
                onClick={() => {
                  resetPresence();
                }}
              >
                {t("appearanceSessionToolbarReset")}
              </button>
            </div>
          </div>
        </HideInSettingsSearch>
        {error && <p className="settings-warning">{error}</p>}
      </div>
    </SettingsSection>
  );
}
