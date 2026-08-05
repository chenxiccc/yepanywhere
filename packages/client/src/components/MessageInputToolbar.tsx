import type {
  ModelInfo,
  ProviderRuntimeStatus,
  ProviderName,
  SessionLivenessSnapshot,
  ShowThinking,
  SlashCommand,
} from "@yep-anywhere/shared";
import {
  DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED,
  VOICE_INPUT_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import type { MouseEvent, RefObject, TouchEvent } from "react";
import {
  type Dispatch,
  type SetStateAction,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useOptionalRenderModeContext } from "../contexts/RenderModeContext";
import { ConversationViewIcon } from "./ConversationViewIcon";
import {
  type EffortLevel,
  type ThinkingMode,
  useModelSettings,
} from "../hooks/useModelSettings";
import { useBrowserXaiSttApiKey } from "../hooks/useBrowserXaiSttApiKey";
import { useConversationView } from "../hooks/useConversationView";
import {
  getComposerToolbarOverflowLayoutSignature,
  type MessageInputToolbarLayoutRefs,
  useMeasuredComposerOverflow,
} from "../hooks/useMessageInputToolbarLayout";
import {
  getTextTooltipAttributes,
  useTooltipMode,
} from "../hooks/useTooltipAppearance";
import { useProviders } from "../hooks/useProviders";
import { useRelativeNow } from "../hooks/useRelativeNow";
import {
  DEFAULT_SESSION_TOOLBAR_PRIORITY,
  type SessionToolbarPriority,
  type SessionToolbarVisibility,
  type SessionToolbarVisibilityKey,
  type ToolbarNarrowingPriority,
  useSessionToolbarPresence,
} from "../hooks/useSessionToolbarPresence";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import type { BtwToolbarMode } from "../lib/btwAsideRouting";
import {
  type EffortLevelOption,
  getEffortLevelLabel,
  getEffortLevelOptions,
  getThinkingModeOptions,
  resolveSupportedEffortLevel,
  resolveSupportedThinkingMode,
} from "../lib/effortLevels";
import {
  formatAbsoluteTimestamp,
  formatCompactRelativeAge,
  isStaleTimestamp,
  parseTimestampMs,
} from "../lib/messageAge";
import { normalizeProviderKey } from "../lib/modelIndicatorText";
import {
  describeProviderRuntimeStatus,
  type ProviderRuntimeDisplay,
} from "../lib/providerRuntimeStatus";
import { getPermissionModeOptions } from "../lib/permissionModes";
import { serverSupportsProjectQueue } from "../lib/projectQueueVisibility";
import {
  SESSION_ISEARCH_GUIDE_EVENT,
  type SessionIsearchGuideState,
  type SessionIsearchScope,
} from "../lib/sessionIsearchGuide";
import {
  DEFAULT_SPEECH_METHOD,
  canSpeechMethodStream,
  getSpeechMethodCapabilities,
  getSpeechMethods,
  isBrowserNativeSpeechAvailable,
  isSpeechMethodId,
  resolveSpeechMethod,
  type SpeechMethodId,
} from "../lib/speechProviders/methods";
import type {
  SpeechSmartTurnSettings,
  SpeechTranscriptionContext,
  SpeechTranscriptionResultMetadata,
  SpeechTranscriptionSettlement,
} from "../lib/speechProviders/SpeechProvider";
import type { ContextUsage, PermissionMode } from "../types";
import { ContextThresholdQuickEdit } from "./ContextThresholdQuickEdit";
import { SpeechPrefixActionCue } from "./SpeechPrefixActionCue";
import type { FilterOption } from "./FilterDropdown";
import { MessageAge } from "./MessageAge";
import { ModeSelector } from "./ModeSelector";
import { SlashCommandButton } from "./SlashCommandButton";
import { SpeechControlMenu } from "./SpeechControlMenu";
import { SpeechWaveform } from "./SpeechWaveform";
import { ThinkingControlsPanel, ThinkingIcon } from "./ThinkingControls";
import { RenderModeGlyph } from "./ui/RenderModeGlyph";
import {
  VoiceInputButton,
  type SpeechCycleSettlement,
  type SpeechPendingKind,
  type VoiceInputButtonRef,
} from "./VoiceInputButton";

type ToolbarTranslate = ReturnType<typeof useI18n>["t"];

// Maps a control's narrowing priority to its overflow-tier CSS class. `first`
// collapses first (early), `mid` next, `last` collapses last; `pin` yields no
// tier class (and its menu copy stays hidden) so the control never collapses.
function priorityToTierClass(priority: ToolbarNarrowingPriority): string {
  switch (priority) {
    case "first":
      return "composer-bottom-overflow-early";
    case "mid":
      return "composer-bottom-overflow-medium";
    case "last":
      return "composer-bottom-overflow-late";
    default:
      return "";
  }
}

function getIsearchPreviousKeys(scope: SessionIsearchScope): string[] {
  if (scope === "full") {
    return ["Ctrl", "Alt", "S"];
  }
  if (scope === "all") {
    return ["Ctrl", "S"];
  }
  return ["Ctrl", "R"];
}

function getIsearchAlternateRows(
  scope: SessionIsearchScope,
  t: ToolbarTranslate,
): Array<{
  scope: SessionIsearchScope;
  keys: string[];
  label: string;
}> {
  return [
    ...(scope === "user"
      ? []
      : [
          {
            scope: "user" as const,
            keys: ["Ctrl", "R"],
            label: t("toolbarShortcutUserTurns"),
          },
        ]),
    ...(scope === "all"
      ? []
      : [
          {
            scope: "all" as const,
            keys: ["Ctrl", "S"],
            label: t("toolbarShortcutAllTurns"),
          },
        ]),
    ...(scope === "full"
      ? []
      : [
          {
            scope: "full" as const,
            keys: ["Ctrl", "Alt", "S"],
            label: t("toolbarShortcutFullSession"),
          },
        ]),
  ];
}

export interface MessageInputToolbarProps {
  // Mode selector
  mode?: PermissionMode;
  onModeChange?: (mode: PermissionMode) => void;
  modeChangesApplyNextTurn?: boolean;
  modeChangePending?: boolean;

  // Provider capability flags (default to true for backwards compatibility)
  supportsPermissionMode?: boolean;
  supportsThinkingToggle?: boolean;

  // Attachments
  canAttach?: boolean;
  attachmentCount?: number;
  onAttachClick?: () => void;

  // Voice input
  voiceButtonRef?: RefObject<VoiceInputButtonRef | null>;
  onVoiceTranscript?: (
    transcript: string,
    metadata?: SpeechTranscriptionResultMetadata,
  ) => void;
  onInterimTranscript?: (transcript: string) => void;
  onListeningStart?: () => void;
  onListeningStop?: () => boolean | undefined;
  onPendingSpeechChange?: (
    kind: SpeechPendingKind | null,
    settlement?: SpeechCycleSettlement,
  ) => void;
  onTranscriptionSettled?: (settlement: SpeechTranscriptionSettlement) => void;
  voiceDisabled?: boolean;
  getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;

  // Slash commands
  slashCommands?: SlashCommand[];
  onSelectSlashCommand?: (command: SlashCommand) => void;
  onBtwClick?: () => void;
  btwActive?: boolean;
  btwHasAsides?: boolean;
  btwToolbarMode?: BtwToolbarMode;
  /** Provider/model context used by the thinking effort chooser. */
  thinkingProvider?: string;
  thinkingModel?: string;
  /** Live process thinking selection for owned active sessions. */
  liveThinkingSelection?: {
    mode: ThinkingMode;
    level: EffortLevel;
    onSetMode: (mode: ThinkingMode) => void;
    onSetEffort: (level: EffortLevel) => void;
  };
  /**
   * YA model id (launch alias) used to key the context quick-edit's per-model
   * compaction threshold. Distinct from `thinkingModel` (the reported model);
   * falls back to it when absent. See topics/provider-abstraction.md.
   */
  contextRequestedModel?: string;

  // Session heartbeat
  heartbeatEnabled?: boolean;
  onToggleHeartbeat?: () => void;
  onConfigureHeartbeat?: () => void;

  // Context usage
  contextUsage?: ContextUsage;
  /** Last session activity timestamp for stale composer liveness display. */
  lastActivityAt?: string | null;
  /** Hovered or scrolled transcript position timestamp for the status line. */
  positionTimestampMs?: number | null;
  /** Server-derived provider/session liveness evidence. */
  sessionLiveness?: SessionLivenessSnapshot | null;
  /** Provider-owned retry/failure status for the active turn. */
  providerRuntimeStatus?: ProviderRuntimeStatus;
  /** Whether the provider exposes a soft-immediate steer lane. */
  showSteerNowMode?: boolean;
  /** Whether steering uses the soft-immediate lane for future sends. */
  steerNowEnabled?: boolean;
  /** Toggle soft-immediate steering for future steer sends. */
  onToggleSteerNow?: () => void;
  /** The action currently bound to Enter in dual-action steering sessions. */
  enterActionKind?: "steer" | "queue";
  /** Whether Enter and Ctrl+Enter may be swapped. */
  canSwapEnterAction?: boolean;
  /** Swap Enter and Ctrl+Enter in dual-action steering sessions. */
  onSwapEnterAction?: () => void;

  // Actions
  isRunning?: boolean;
  isThinking?: boolean;
  onStop?: () => void;
  onSend?: () => void;
  /** Queue a deferred message. Only provided when agent is running. */
  onQueue?: () => void;
  /** Queue through the project-level idle gate. Hidden unless opted in. */
  onProjectQueue?: () => void;
  /** Queue the draft as a new session after the project becomes idle. */
  onProjectQueueNewSession?: () => void;
  /** Steer the current turn. Used as the alternate action when Enter queues. */
  onSteer?: () => void;
  primaryActionKind?: "send" | "steer" | "queue";
  sendOverride?: {
    label: string;
    tooltip: string;
    icon: string;
  };
  sendAlternate?: {
    label: string;
    tooltip: string;
    icon: string;
    onClick: () => void;
  };
  canForkAfterSummary?: boolean;
  canSend?: boolean;
  /** Exact prefix this delivery will prepend, or null for an unchanged payload. */
  speechMessagePrefix?: string | null;
  /** Primary-action override for local-only composer commands. */
  primarySpeechMessagePrefix?: string | null;
  disabled?: boolean;
  /** Keep toolbar utilities/settings but omit the ordinary primary/alternate actions. */
  hidePrimaryDeliveryActions?: boolean;
  /** Keep the live mic outside this toolbar instance. */
  hideVoiceInput?: boolean;

  // Pending approval indicator
  pendingApproval?: {
    type: "tool-approval" | "user-question";
    onExpand: () => void;
  };
}

export type LivenessTone = "ok" | "warn" | "danger" | "muted";

export interface LivenessDisplay {
  prefix: string;
  timestampMs: number | null;
  tone: LivenessTone;
  title: string;
}

function describeSessionLiveness(
  snapshot: SessionLivenessSnapshot,
  t: ToolbarTranslate,
): LivenessDisplay {
  const checkedMs = parseTimestampMs(snapshot.checkedAt);
  const stateMs = parseTimestampMs(snapshot.lastStateChangeAt);
  const progressMs = parseTimestampMs(
    snapshot.lastVerifiedProgressAt ?? snapshot.lastProviderMessageAt,
  );
  const idleMs = parseTimestampMs(snapshot.lastVerifiedIdleAt);
  const title = [
    `status: ${snapshot.derivedStatus}`,
    `work: ${snapshot.activeWorkKind}`,
    snapshot.lastRawProviderEventAt
      ? `raw provider: ${snapshot.lastRawProviderEventSource ?? "unknown"} at ${snapshot.lastRawProviderEventAt}`
      : null,
    `evidence: ${snapshot.evidence.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  switch (snapshot.derivedStatus) {
    case "verified-progressing":
      return {
        prefix: t("toolbarLivenessVerifiedProgress"),
        timestampMs: progressMs ?? checkedMs,
        tone: "ok",
        title,
      };
    case "recently-active-unverified":
      return {
        prefix: t("toolbarLivenessUnverifiedTurn"),
        timestampMs: stateMs ?? checkedMs,
        tone: "warn",
        title,
      };
    case "long-silent-unverified":
      return {
        prefix: t("toolbarLivenessLongSilent"),
        timestampMs: progressMs ?? stateMs ?? checkedMs,
        tone: "danger",
        title,
      };
    case "verified-waiting-provider":
      return {
        prefix: t("toolbarLivenessWaitingOnProvider"),
        timestampMs: progressMs ?? stateMs ?? checkedMs,
        tone: "warn",
        title,
      };
    case "verified-idle":
      return {
        prefix: t("toolbarLivenessVerifiedIdle"),
        timestampMs: idleMs ?? stateMs ?? checkedMs,
        tone: "muted",
        title,
      };
    case "needs-attention":
      return {
        prefix:
          snapshot.activeWorkKind === "waiting-input"
            ? t("toolbarLivenessNeedsInput")
            : t("toolbarLivenessNeedsAttention"),
        timestampMs: stateMs ?? checkedMs,
        tone: "danger",
        title,
      };
  }

  const unhandledStatus: never = snapshot.derivedStatus;
  return {
    prefix: t("toolbarLivenessUnknownState"),
    timestampMs: checkedMs,
    tone: "warn",
    title: `${title}\nunknown status: ${String(unhandledStatus)}`,
  };
}

function formatLivenessAge(
  t: ToolbarTranslate,
  timestampMs: number,
  nowMs: number,
): string {
  const label = formatCompactRelativeAge(timestampMs, nowMs);
  return label === "now"
    ? t("toolbarRelativeAgeNow")
    : t("toolbarRelativeAgePast", { age: label });
}

function describeLivenessSummary(
  t: ToolbarTranslate,
  display: LivenessDisplay,
  nowMs: number,
): string {
  if (display.timestampMs === null) {
    return display.prefix;
  }
  return t("toolbarLivenessSummary", {
    state: display.prefix,
    age: formatLivenessAge(t, display.timestampMs, nowMs),
  });
}

function getBtwTitle(mode: BtwToolbarMode, t: ToolbarTranslate): string {
  switch (mode) {
    case "child-session":
      return t("toolbarBtwChildSessionTitle");
    case "focused-footer":
      return t("toolbarBtwFocusedFooterTitle");
    case "focused-pane":
      return t("toolbarBtwFocusedPaneTitle");
    case "focus-existing":
      return t("toolbarBtwFocusExistingTitle");
    case "start":
      return t("toolbarBtwStartTitle");
  }
}

function isBtwPressed(mode: BtwToolbarMode): boolean {
  return (
    mode === "child-session" ||
    mode === "focused-footer" ||
    mode === "focused-pane"
  );
}

const LAST_ACTIVITY_TEXT_PREFIX_THRESHOLD_MS = 30 * 60 * 1000;
const COMPACT_STATUS_QUERY = "(max-width: 600px)";

// Widening headroom required before measured-compact status mode releases;
// see updateCompactStatusMode for why exiting needs more than merely fitting.
const COMPACT_STATUS_EXIT_SLACK_PX = 72;

function getCompactStatusMatchMedia() {
  if (
    typeof window === "undefined" ||
    typeof window.matchMedia !== "function"
  ) {
    return null;
  }
  return window.matchMedia(COMPACT_STATUS_QUERY);
}

type ToolbarRenderModeState = "rendered" | "source" | "mixed";

interface ToolbarModeControl {
  mode: PermissionMode;
  onModeChange: (mode: PermissionMode) => void;
  modes?: readonly PermissionMode[];
  changesApplyNextTurn?: boolean;
  modeChangePending?: boolean;
}

interface ToolbarAttachmentControl {
  canAttach?: boolean;
  attachmentCount: number;
  onAttachClick?: () => void;
}

interface ToolbarSlashControl {
  commands: SlashCommand[];
  onSelectCommand: (command: SlashCommand) => void;
  disabled?: boolean;
}

interface ToolbarThinkingControl {
  mode: ThinkingMode;
  modeOptions?: readonly ThinkingMode[];
  level: EffortLevel;
  effortOptions: EffortLevelOption[];
  onSetMode: (mode: ThinkingMode) => void;
  onSetEffort: (level: EffortLevel) => void;
  onSetEffortMode?: (level: EffortLevel) => void;
  onToggleEnabled: () => void;
  /** "Show thinking" preference (default/on/off); all providers. */
  showThinking: ShowThinking;
  onSetShowThinking: (value: ShowThinking) => void;
  /** Provider for resolving the inherited "default" show-thinking cue. */
  provider?: string | null;
}

interface ToolbarRenderModeControl {
  state: ToolbarRenderModeState;
  title: string;
  onToggle: () => void;
}

interface ToolbarConversationViewControl {
  enabled: boolean;
  title: string;
  onToggle: () => void;
}

interface ToolbarNudgeControl {
  enabled: boolean;
  title: string;
  onClick: () => void;
  onContextMenu: (e: MouseEvent<HTMLButtonElement>) => void;
  onTouchStart: () => void;
  onTouchEnd: (e: TouchEvent<HTMLButtonElement>) => void;
  onClearTouch: () => void;
}

type ToolbarVoiceButtonControl =
  | {
      kind: "live";
      ref?: RefObject<VoiceInputButtonRef | null>;
      onTranscript: (
        transcript: string,
        metadata?: SpeechTranscriptionResultMetadata,
      ) => void;
      onInterimTranscript: (transcript: string) => void;
      onListeningStart?: () => void;
      onListeningStop?: () => boolean | undefined;
      onPendingSpeechChange?: (
        kind: SpeechPendingKind | null,
        settlement?: SpeechCycleSettlement,
      ) => void;
      onTranscriptionSettled?: (
        settlement: SpeechTranscriptionSettlement,
      ) => void;
      showWaveform?: boolean;
      disabled?: boolean;
      speechMethod: SpeechMethodId;
      getTranscriptionContext?: () => SpeechTranscriptionContext | undefined;
      smartTurn?: SpeechSmartTurnSettings;
    }
  | {
      kind: "preview";
      disabled?: boolean;
    };

interface ToolbarSpeechControl {
  showMethodSelector: boolean;
  methodOptions: FilterOption<SpeechMethodId>[];
  selectedMethod: SpeechMethodId;
  onMethodChange: (selected: string[]) => void;
  smartTurnSettings?: SpeechSmartTurnSettings;
  onSmartTurnSettingsChange?: (settings: SpeechSmartTurnSettings) => void;
  smartTurnDisabled?: boolean;
  voiceButton?: ToolbarVoiceButtonControl;
}

interface ToolbarStatusControl {
  showToolbarStatus: boolean;
  showLivenessChip: boolean;
  livenessDisplay: LivenessDisplay | null;
  livenessSummary: string | null;
  providerRuntimeDisplay?: ProviderRuntimeDisplay | null;
  nowMs: number;
  showLastActivityChip: boolean;
  showLastActivityPrefix: boolean;
  lastActivityMs: number | null;
  lastActivityIsPast: boolean;
  positionTimestampMs: number | null;
  showPositionTimestamp: boolean;
  /** Position age present regardless of the sessionStatus toggle (compact float). */
  hasPositionAge: boolean;
  /** Last-activity freshness present regardless of the sessionStatus toggle. */
  hasLastActivityAge: boolean;
}

interface ToolbarShortcutsControl {
  open: boolean;
  isearchScope: SessionIsearchScope | null;
  setOpen: Dispatch<SetStateAction<boolean>>;
  settingsOpen: boolean;
  setSettingsOpen: Dispatch<SetStateAction<boolean>>;
  hasDualActions: boolean;
  enterActionKind: "send" | "steer" | "queue";
  canSwapEnterAction: boolean;
  onSwapEnterAction?: () => void;
  queueShortcutLabel: string;
  canForkAfterSummary?: boolean;
}

interface ToolbarBtwControl {
  onClick: () => void;
  pressed: boolean;
  mode: BtwToolbarMode;
  title: string;
}

interface ToolbarQueueControl {
  onQueue?: () => void;
  onSteer?: () => void;
  hasDualActions: boolean;
  queueTooltip: string;
}

interface ToolbarSendControl {
  onSend?: () => void;
  onSteer?: () => void;
  canSend?: boolean;
  primaryActionKind: "send" | "steer" | "queue";
  primaryActionLabel: string;
  tooltip: string;
  icon: string;
  speechMessagePrefix?: string | null;
  primarySpeechMessagePrefix?: string | null;
  showSteerNowMode?: boolean;
  steerNowEnabled?: boolean;
  onToggleSteerNow?: () => void;
  queue?: ToolbarQueueControl;
  alternate?: {
    label: string;
    tooltip: string;
    icon: string;
    onClick: () => void;
  };
}

interface ToolbarProjectQueueControl {
  onProjectQueue?: () => void;
  onProjectQueueNewSession?: () => void;
  canSend?: boolean;
  tooltip?: string;
  newSessionTooltip?: string;
}

interface ToolbarStopControl {
  onStop: () => void;
  title: string;
}

interface ToolbarActionsControl {
  disabled?: boolean;
  voiceDisabled?: boolean;
  contextUsage?: ContextUsage;
  /** Session model id, for the long-press compact-threshold quick-edit. */
  contextModel?: string;
  /** Provider account whose subscription windows apply to the context model. */
  contextProvider?: ProviderName;
  /** Model context window, for the quick-edit token preview. */
  contextWindow?: number;
  btw?: ToolbarBtwControl | null;
  stop?: ToolbarStopControl | null;
  projectQueue?: ToolbarProjectQueueControl | null;
  send?: ToolbarSendControl | null;
}

export interface MessageInputToolbarViewProps {
  t: ToolbarTranslate;
  refs?: MessageInputToolbarLayoutRefs;
  visibility: SessionToolbarVisibility;
  /** Per-control narrowing priority; defaults to the built-in tiers when absent. */
  priority?: SessionToolbarPriority;
  isCompactStatusMode?: boolean;
  modeControl?: ToolbarModeControl | null;
  attachmentControl: ToolbarAttachmentControl;
  slashControl?: ToolbarSlashControl | null;
  thinkingControl?: ToolbarThinkingControl | null;
  renderModeControl?: ToolbarRenderModeControl | null;
  conversationViewControl?: ToolbarConversationViewControl | null;
  nudgeControl?: ToolbarNudgeControl | null;
  speechControl?: ToolbarSpeechControl | null;
  speechWaveformActive?: boolean;
  statusControl?: ToolbarStatusControl | null;
  pendingApproval?: MessageInputToolbarProps["pendingApproval"];
  shortcutsControl: ToolbarShortcutsControl;
  actionsControl: ToolbarActionsControl;
  hidePrimaryDeliveryActions?: boolean;
}

function ToolbarMicrophoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  );
}

function getToolbarThinkingLabel(
  t: ToolbarTranslate,
  control: ToolbarThinkingControl,
): string {
  if (control.mode === "off") return t("modelSettingsThinkingOffLabel");
  if (control.mode === "auto") return t("modelSettingsThinkingAutoLabel");
  if (control.level === "xhigh") return t("effortLevelExtraHighShortLabel");
  return (
    control.effortOptions.find((option) => option.value === control.level)
      ?.label ?? getEffortLevelLabel(control.level, undefined, t)
  );
}

function getToolbarThinkingTitle(
  t: ToolbarTranslate,
  control: ToolbarThinkingControl,
): string {
  const current =
    control.mode === "off"
      ? t("newSessionThinkingOff")
      : control.mode === "auto"
        ? t("newSessionThinkingAuto")
        : t("newSessionThinkingOn", {
            level:
              control.effortOptions.find(
                (option) => option.value === control.level,
              )?.label ?? getEffortLevelLabel(control.level, undefined, t),
          });
  return t("toolbarThinkingTitle", { current });
}

function ThinkingToolbarControl({
  control,
  t,
}: {
  control: ToolbarThinkingControl;
  t: ToolbarTranslate;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressTouchClickRef = useRef(false);
  const title = getToolbarThinkingTitle(t, control);

  const close = useCallback(() => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };
    const handleMouseDown = (event: globalThis.MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        close();
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [close, open]);

  const clearLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const toggleEnabled = useCallback(() => {
    control.onToggleEnabled();
    setOpen(false);
  }, [control]);

  const handleContextMenu = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      event.preventDefault();
      toggleEnabled();
    },
    [toggleEnabled],
  );

  const handleTouchStart = useCallback(() => {
    clearLongPress();
    suppressTouchClickRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      suppressTouchClickRef.current = true;
      longPressTimerRef.current = null;
      toggleEnabled();
    }, 450);
  }, [clearLongPress, toggleEnabled]);

  const handleTouchEnd = useCallback(
    (event: TouchEvent<HTMLButtonElement>) => {
      if (suppressTouchClickRef.current) {
        event.preventDefault();
      }
      clearLongPress();
    },
    [clearLongPress],
  );

  return (
    <div className="thinking-toolbar-control" ref={rootRef}>
      <button
        type="button"
        className={`thinking-toggle-button ${control.mode !== "off" ? `active ${control.mode}` : ""}`}
        onClick={(event) => {
          if (suppressTouchClickRef.current) {
            suppressTouchClickRef.current = false;
            return;
          }
          event.currentTarget.blur();
          setOpen((current) => !current);
        }}
        onContextMenu={handleContextMenu}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
        onTouchCancel={clearLongPress}
        onTouchMove={clearLongPress}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <ThinkingIcon mode={control.mode} />
        <span className="thinking-toggle-label">
          {getToolbarThinkingLabel(t, control)}
        </span>
      </button>
      {open && (
        <div className="thinking-toolbar-menu" role="menu">
          <ThinkingControlsPanel
            mode={control.mode}
            modeOptions={control.modeOptions}
            onSetMode={control.onSetMode}
            level={control.level}
            effortOptions={control.effortOptions}
            onSetEffort={control.onSetEffort}
            onSetEffortMode={control.onSetEffortMode}
            showThinking={control.showThinking}
            onSetShowThinking={control.onSetShowThinking}
            provider={control.provider}
            t={t}
            onSelect={close}
            optionRole="menuitemradio"
          />
          <div className="thinking-toolbar-menu-hint">
            {t("toolbarThinkingAppliesNextTurn")}
          </div>
        </div>
      )}
    </div>
  );
}

export function MessageInputToolbarView({
  t,
  refs,
  visibility,
  priority,
  isCompactStatusMode = false,
  modeControl,
  attachmentControl,
  slashControl,
  thinkingControl,
  renderModeControl,
  conversationViewControl,
  nudgeControl,
  speechControl,
  speechWaveformActive = false,
  statusControl,
  pendingApproval,
  shortcutsControl,
  actionsControl,
  hidePrimaryDeliveryActions = false,
}: MessageInputToolbarViewProps) {
  const tooltipMode = useTooltipMode();
  const controlPriority = priority ?? DEFAULT_SESSION_TOOLBAR_PRIORITY;
  // Inline copy always carries `-inline`; append the priority-derived tier (or
  // nothing when pinned). Menu copy carries just the tier. Both mirror each
  // other so a control's inline and menu presentations stay mutually exclusive.
  const inlineTierClass = (
    key: SessionToolbarVisibilityKey,
    ...extra: string[]
  ): string =>
    [
      ...extra,
      "composer-bottom-overflow-inline",
      priorityToTierClass(controlPriority[key]),
    ]
      .filter(Boolean)
      .join(" ");
  const menuTierClass = (
    key: SessionToolbarVisibilityKey,
    ...extra: string[]
  ): string => {
    const tierClass = priorityToTierClass(controlPriority[key]);
    return [...extra, tierClass || "composer-bottom-overflow-pinned"]
      .filter(Boolean)
      .join(" ");
  };
  const isPriorityCollapsible = (key: SessionToolbarVisibilityKey): boolean =>
    controlPriority[key] !== "pin";
  const shortcutsPopoverOpen = shortcutsControl.open;
  const shortcutSettings =
    shortcutsControl.canSwapEnterAction && shortcutsControl.onSwapEnterAction
      ? { onSwapEnterAction: shortcutsControl.onSwapEnterAction }
      : null;
  // The status ages float whenever the inline expanded row is unavailable:
  // compact viewport, mobile layout, or the sessionStatus toggle off.
  const statusFloats = isCompactStatusMode || !visibility.sessionStatus;
  // The float carries only the two ages. The liveness chip is inline-only:
  // floated it degrades to a bare "now"/"5m" pill with none of the liveness
  // framing the inline row gives it.
  const showLivenessChip =
    !statusFloats && (statusControl?.showLivenessChip ?? false);
  const livenessDisplay = statusControl?.livenessDisplay ?? null;
  const providerRuntimeDisplay = statusControl?.providerRuntimeDisplay ?? null;
  const showPositionChip =
    (statusControl?.showPositionTimestamp ?? false) ||
    (statusFloats && (statusControl?.hasPositionAge ?? false));
  const showLastActivityChip =
    (statusControl?.showLastActivityChip ?? false) ||
    (statusFloats && (statusControl?.hasLastActivityAge ?? false));
  const showProviderRuntimeChip = !!providerRuntimeDisplay;
  const showToolbarStatus =
    showProviderRuntimeChip ||
    showLivenessChip ||
    showPositionChip ||
    showLastActivityChip;
  // The floating presentation needs `.status-floats` so the ages anchor over
  // the composer; wide+enabled keeps the inline row's positioning context.
  const applyStatusFloats =
    isCompactStatusMode || (statusFloats && showToolbarStatus);
  const showSendButton = !!(
    !hidePrimaryDeliveryActions && actionsControl.send?.onSend
  );
  const showStopButton = !!actionsControl.stop;
  const showCurrentSessionProjectQueueButton = !!(
    visibility.projectQueue &&
    actionsControl.projectQueue?.onProjectQueue &&
    actionsControl.send
  );
  const showNewSessionProjectQueueButton = !!(
    visibility.projectQueueNewSessionShortcut &&
    actionsControl.projectQueue?.onProjectQueueNewSession &&
    actionsControl.send
  );
  const showProjectQueueButton =
    showCurrentSessionProjectQueueButton || showNewSessionProjectQueueButton;
  const selectedSpeechMethod = speechControl?.selectedMethod;
  const queueControl = actionsControl.send?.queue;
  const canToggleSteerNow = !!(
    visibility.steerNow &&
    actionsControl.send?.showSteerNowMode &&
    actionsControl.send.onToggleSteerNow
  );
  const showActionsControl =
    showProjectQueueButton || showSendButton || canToggleSteerNow;
  const renderStatusAges = (
    className: string,
    ref?: RefObject<HTMLDivElement | null>,
  ) => {
    if (!showToolbarStatus || !statusControl) {
      return null;
    }

    return (
      <div ref={ref} className={className}>
        {showLivenessChip && livenessDisplay && (
          <div
            className={`composer-status-chip composer-liveness-status is-${livenessDisplay.tone}`}
            role="status"
            aria-label={t("toolbarLivenessAria", {
              summary: statusControl.livenessSummary ?? "",
            })}
            title={livenessDisplay.title}
          >
            {livenessDisplay.timestampMs !== null ? (
              <time
                className="composer-liveness-time"
                dateTime={new Date(livenessDisplay.timestampMs).toISOString()}
                title={`${formatAbsoluteTimestamp(livenessDisplay.timestampMs)}\n${livenessDisplay.title}`}
              >
                {formatLivenessAge(
                  t,
                  livenessDisplay.timestampMs,
                  statusControl.nowMs,
                )}
              </time>
            ) : (
              <span className="composer-liveness-time">
                {livenessDisplay.prefix}
              </span>
            )}
          </div>
        )}
        {showProviderRuntimeChip && providerRuntimeDisplay && (
          <div
            className={`composer-status-chip composer-provider-runtime-status is-${providerRuntimeDisplay.tone}`}
            role="status"
            aria-label={t("toolbarProviderRuntimeAria", {
              summary: providerRuntimeDisplay.summary,
            })}
            title={providerRuntimeDisplay.title}
          >
            {providerRuntimeDisplay.retryAtMs !== null ? (
              <time
                className="composer-provider-runtime-time"
                dateTime={new Date(
                  providerRuntimeDisplay.retryAtMs,
                ).toISOString()}
              >
                {providerRuntimeDisplay.summary}
              </time>
            ) : (
              <span className="composer-provider-runtime-time">
                {providerRuntimeDisplay.summary}
              </span>
            )}
          </div>
        )}
        {showPositionChip && (
          <div
            className="composer-status-chip composer-position-age composer-activity-age--compact"
            role="status"
            aria-label={t("toolbarPositionAgeAria")}
          >
            <MessageAge
              timestampMs={statusControl.positionTimestampMs}
              nowMs={statusControl.nowMs}
              className="composer-position-age-time"
              formatLabel={(label) => {
                const localizedLabel =
                  label === "now"
                    ? t("toolbarRelativeAgeNow")
                    : t("toolbarRelativeAgePast", { age: label });
                return t("toolbarPositionAge", { age: localizedLabel });
              }}
            />
          </div>
        )}
        {showLastActivityChip && (
          <div
            className={`composer-status-chip composer-activity-age${
              statusControl.showLastActivityPrefix
                ? ""
                : " composer-activity-age--compact"
            }`}
            role="status"
            aria-label={t("toolbarLastActivityAria")}
          >
            <MessageAge
              timestampMs={statusControl.lastActivityMs}
              nowMs={statusControl.nowMs}
              className="composer-activity-age-time"
              formatLabel={(label) => {
                const localizedLabel =
                  label === "now" ? t("toolbarRelativeAgeNow") : label;
                if (statusControl.showLastActivityPrefix) {
                  return t("toolbarLastActivityAge", {
                    age: localizedLabel,
                  });
                }
                return statusControl.lastActivityIsPast
                  ? t("toolbarRelativeAgePast", { age: localizedLabel })
                  : localizedLabel;
              }}
            />
          </div>
        )}
      </div>
    );
  };
  const renderContextUsage = (className: string) => {
    if (!visibility.contextUsage || !actionsControl.contextUsage) {
      return null;
    }
    return (
      <span className={className}>
        <ContextThresholdQuickEdit
          usage={actionsControl.contextUsage}
          model={actionsControl.contextModel}
          provider={actionsControl.contextProvider}
          contextWindow={actionsControl.contextWindow}
          size={16}
        />
      </span>
    );
  };
  const renderBtwButton = (className: string, menu = false) => {
    if (!visibility.btw || !actionsControl.btw) {
      return null;
    }
    return (
      <button
        type="button"
        className={className}
        onClick={actionsControl.btw.onClick}
        disabled={actionsControl.disabled || actionsControl.voiceDisabled}
        aria-label={actionsControl.btw.title}
        aria-pressed={actionsControl.btw.pressed}
        title={actionsControl.btw.title}
        role={menu ? "menuitem" : undefined}
      >
        /btw
      </button>
    );
  };
  const renderSteerNowToggle = (className: string) => {
    if (!canToggleSteerNow || !actionsControl.send) {
      return null;
    }
    return (
      <label className={className} title={t("toolbarSteerNowTooltip")}>
        <input
          type="checkbox"
          checked={!!actionsControl.send.steerNowEnabled}
          onChange={actionsControl.send.onToggleSteerNow}
          disabled={actionsControl.disabled}
          aria-label={t("toolbarSteerNowLabel")}
        />
        <span>{t("toolbarSteerNowShortLabel")}</span>
      </label>
    );
  };
  const renderProjectQueueButtons = (menu = false) => {
    if (
      !showProjectQueueButton ||
      !actionsControl.projectQueue ||
      !actionsControl.send
    ) {
      return null;
    }
    const projectQueue = actionsControl.projectQueue;
    const disabled = actionsControl.disabled || !projectQueue.canSend;
    const speechPrefix = actionsControl.send.speechMessagePrefix;
    const deliveryLabel = (label: string) =>
      speechPrefix
        ? t("speechPrefixDeliveryLabel", {
            action: label,
            prefix: speechPrefix,
          })
        : label;
    const deliveryTooltip = (tooltip: string | undefined) =>
      speechPrefix && tooltip
        ? t("speechPrefixDeliveryTooltip", {
            tooltip,
            prefix: speechPrefix,
          })
        : tooltip;
    const classNameFor = (
      key: "projectQueue" | "projectQueueNewSessionShortcut",
      ...extra: string[]
    ) =>
      (menu ? menuTierClass : inlineTierClass)(
        key,
        "send-button",
        "project-queue-button",
        ...extra,
      );
    return (
      <>
        {showCurrentSessionProjectQueueButton &&
          (!menu || isPriorityCollapsible("projectQueue")) && (
            <button
              type="button"
              onClick={projectQueue.onProjectQueue}
              disabled={disabled}
              className={classNameFor("projectQueue")}
              aria-label={deliveryLabel(t("toolbarProjectQueueLabel"))}
              title={deliveryTooltip(projectQueue.tooltip)}
              role={menu ? "menuitem" : undefined}
            >
              <span className="send-icon">⇥</span>
              {speechPrefix && <SpeechPrefixActionCue prefix={speechPrefix} />}
            </button>
          )}
        {showNewSessionProjectQueueButton &&
          (!menu ||
            isPriorityCollapsible("projectQueueNewSessionShortcut")) && (
            <button
              type="button"
              onClick={projectQueue.onProjectQueueNewSession}
              disabled={disabled}
              className={classNameFor(
                "projectQueueNewSessionShortcut",
                "project-queue-new-session-button",
              )}
              aria-label={deliveryLabel(
                t("toolbarProjectQueueNewSessionLabel"),
              )}
              title={deliveryTooltip(projectQueue.newSessionTooltip)}
              role={menu ? "menuitem" : undefined}
            >
              <span className="send-icon">⇥</span>
              <span
                className="project-queue-new-session-mark"
                aria-hidden="true"
              >
                +
              </span>
              {speechPrefix && <SpeechPrefixActionCue prefix={speechPrefix} />}
            </button>
          )}
      </>
    );
  };
  const hasBottomOverflowControls = !!(
    (visibility.modeSelector &&
      modeControl &&
      isPriorityCollapsible("modeSelector")) ||
    (visibility.attachments && isPriorityCollapsible("attachments")) ||
    (visibility.slashMenu &&
      slashControl &&
      isPriorityCollapsible("slashMenu")) ||
    (visibility.thinkingToggle &&
      thinkingControl &&
      isPriorityCollapsible("thinkingToggle")) ||
    (visibility.renderMode &&
      renderModeControl &&
      isPriorityCollapsible("renderMode")) ||
    (visibility.conversationView &&
      conversationViewControl &&
      isPriorityCollapsible("conversationView")) ||
    (visibility.nudge && nudgeControl && isPriorityCollapsible("nudge")) ||
    (visibility.sessionStatus &&
      showToolbarStatus &&
      statusControl &&
      isPriorityCollapsible("sessionStatus")) ||
    (visibility.shortcutsHelp && isPriorityCollapsible("shortcutsHelp")) ||
    (visibility.contextUsage &&
      actionsControl.contextUsage &&
      isPriorityCollapsible("contextUsage")) ||
    (visibility.btw && actionsControl.btw && isPriorityCollapsible("btw")) ||
    (canToggleSteerNow && isPriorityCollapsible("steerNow")) ||
    (showCurrentSessionProjectQueueButton &&
      actionsControl.send &&
      isPriorityCollapsible("projectQueue")) ||
    (showNewSessionProjectQueueButton &&
      actionsControl.send &&
      isPriorityCollapsible("projectQueueNewSessionShortcut"))
  );
  const bottomOverflowLayoutKey = getComposerToolbarOverflowLayoutSignature({
    modeSelector:
      visibility.modeSelector && modeControl
        ? controlPriority.modeSelector
        : "off",
    attachments: visibility.attachments ? controlPriority.attachments : "off",
    slashMenu:
      visibility.slashMenu && slashControl ? controlPriority.slashMenu : "off",
    thinkingToggle:
      visibility.thinkingToggle && thinkingControl
        ? controlPriority.thinkingToggle
        : "off",
    renderMode:
      visibility.renderMode && renderModeControl
        ? controlPriority.renderMode
        : "off",
    conversationView:
      visibility.conversationView && conversationViewControl
        ? controlPriority.conversationView
        : "off",
    nudge: visibility.nudge && nudgeControl ? controlPriority.nudge : "off",
    sessionStatus:
      visibility.sessionStatus && showToolbarStatus && statusControl
        ? controlPriority.sessionStatus
        : "off",
    shortcutsHelp: visibility.shortcutsHelp
      ? controlPriority.shortcutsHelp
      : "off",
    contextUsage:
      visibility.contextUsage && actionsControl.contextUsage
        ? controlPriority.contextUsage
        : "off",
    btw: visibility.btw && actionsControl.btw ? controlPriority.btw : "off",
    steerNow: canToggleSteerNow ? controlPriority.steerNow : "off",
    projectQueue:
      showCurrentSessionProjectQueueButton && actionsControl.send
        ? controlPriority.projectQueue
        : "off",
    projectQueueNewSessionShortcut:
      showNewSessionProjectQueueButton && actionsControl.send
        ? controlPriority.projectQueueNewSessionShortcut
        : "off",
    microphone:
      visibility.microphone &&
      selectedSpeechMethod &&
      speechControl?.voiceButton
        ? speechControl.voiceButton.kind
        : "off",
    waveform: speechWaveformActive,
    send: showSendButton ? actionsControl.send?.primaryActionKind : "off",
    queue:
      !hidePrimaryDeliveryActions && queueControl?.hasDualActions
        ? [
            actionsControl.send?.primaryActionKind,
            !!queueControl.onQueue,
            !!queueControl.onSteer,
          ].join(":")
        : "off",
    alternate: !hidePrimaryDeliveryActions && !!actionsControl.send?.alternate,
    stop: showStopButton,
    pending: pendingApproval?.type ?? "off",
  });
  const [bottomOverflowOpen, setBottomOverflowOpen] = useState(false);
  const { tier: bottomOverflowTier, setToolbarRef } =
    useMeasuredComposerOverflow({
      layoutKey: bottomOverflowLayoutKey,
      hasControls: hasBottomOverflowControls,
      refs,
    });
  const shortcutsLongPressTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);

  const openShortcutSettings = () => {
    shortcutsControl.setOpen(true);
    shortcutsControl.setSettingsOpen(true);
  };
  const clearShortcutsLongPress = () => {
    if (shortcutsLongPressTimerRef.current) {
      clearTimeout(shortcutsLongPressTimerRef.current);
      shortcutsLongPressTimerRef.current = null;
    }
  };
  const startShortcutsLongPress = () => {
    clearShortcutsLongPress();
    shortcutsLongPressTimerRef.current = setTimeout(() => {
      shortcutsLongPressTimerRef.current = null;
      openShortcutSettings();
    }, 520);
  };

  return (
    <div
      ref={setToolbarRef}
      className={`message-input-toolbar${applyStatusFloats ? " status-floats" : ""} overflow-tier-${bottomOverflowTier}`}
    >
      <div ref={refs?.left} className="message-input-left">
        {visibility.modeSelector && modeControl && (
          <span className={inlineTierClass("modeSelector")}>
            <ModeSelector
              mode={modeControl.mode}
              onModeChange={modeControl.onModeChange}
              modes={modeControl.modes}
              changesApplyNextTurn={modeControl.changesApplyNextTurn}
              modeChangePending={modeControl.modeChangePending}
            />
          </span>
        )}
        {visibility.attachments && (
          <button
            type="button"
            className={inlineTierClass("attachments", "attach-button")}
            onClick={attachmentControl.onAttachClick}
            disabled={!attachmentControl.canAttach}
            title={
              attachmentControl.canAttach
                ? t("toolbarAttachFiles")
                : t("toolbarAttachDisabled")
            }
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              aria-hidden="true"
            >
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
            </svg>
            {attachmentControl.attachmentCount > 0 && (
              <span className="attach-count">
                {attachmentControl.attachmentCount}
              </span>
            )}
          </button>
        )}
        {visibility.slashMenu && slashControl && (
          <span className={inlineTierClass("slashMenu")}>
            <SlashCommandButton
              commands={slashControl.commands}
              onSelectCommand={slashControl.onSelectCommand}
              disabled={slashControl.disabled}
            />
          </span>
        )}
        {visibility.thinkingToggle && thinkingControl && (
          <span className={inlineTierClass("thinkingToggle")}>
            <ThinkingToolbarControl control={thinkingControl} t={t} />
          </span>
        )}
        {visibility.renderMode && renderModeControl && (
          <button
            type="button"
            className={inlineTierClass(
              "renderMode",
              "render-mode-toolbar-button",
              renderModeControl.state === "rendered"
                ? "is-rendered"
                : renderModeControl.state === "mixed"
                  ? "is-mixed"
                  : "",
            )}
            onClick={renderModeControl.onToggle}
            title={renderModeControl.title}
            aria-label={renderModeControl.title}
            aria-pressed={
              renderModeControl.state === "mixed"
                ? "mixed"
                : renderModeControl.state === "rendered"
            }
          >
            <RenderModeGlyph />
          </button>
        )}
        {visibility.conversationView && conversationViewControl && (
          <button
            type="button"
            className={inlineTierClass(
              "conversationView",
              "conversation-view-toolbar-button",
              conversationViewControl.enabled ? "active" : "",
            )}
            onClick={conversationViewControl.onToggle}
            title={conversationViewControl.title}
            aria-label={conversationViewControl.title}
            aria-pressed={conversationViewControl.enabled}
          >
            <ConversationViewIcon />
          </button>
        )}
        {visibility.nudge && nudgeControl && (
          <button
            type="button"
            className={inlineTierClass(
              "nudge",
              "heartbeat-toolbar-button",
              nudgeControl.enabled ? "active" : "",
            )}
            onClick={nudgeControl.onClick}
            onContextMenu={nudgeControl.onContextMenu}
            onTouchStart={nudgeControl.onTouchStart}
            onTouchEnd={nudgeControl.onTouchEnd}
            onTouchCancel={nudgeControl.onClearTouch}
            onTouchMove={nudgeControl.onClearTouch}
            title={nudgeControl.title}
            aria-label={nudgeControl.title}
            aria-pressed={nudgeControl.enabled}
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="miter"
              aria-hidden="true"
            >
              <path className="heartbeat-baseline" d="M0.75 15H7" />
              <path
                className="heartbeat-excursion"
                d="M7 15l2-5 2 9 4-16 3 12"
              />
              <path className="heartbeat-baseline" d="M18 15h5.25" />
            </svg>
          </button>
        )}
        {visibility.microphone &&
          selectedSpeechMethod &&
          speechControl?.voiceButton?.kind === "preview" && (
            <SpeechControlMenu
              showMethodSelector={speechControl.showMethodSelector}
              methodOptions={speechControl.methodOptions}
              selectedMethod={selectedSpeechMethod}
              onMethodChange={speechControl.onMethodChange}
              smartTurnSettings={speechControl.smartTurnSettings}
              onSmartTurnSettingsChange={
                speechControl.onSmartTurnSettingsChange
              }
              smartTurnDisabled={speechControl.smartTurnDisabled}
              trigger={
                <button
                  type="button"
                  className="voice-input-button"
                  disabled={speechControl.voiceButton.disabled}
                  title={t("voiceInputStart" as never)}
                  aria-label={t("voiceInputStartLabel" as never)}
                >
                  <ToolbarMicrophoneIcon />
                </button>
              }
            />
          )}
        {visibility.microphone &&
          selectedSpeechMethod &&
          speechControl?.voiceButton?.kind === "live" &&
          speechControl.voiceButton.ref && (
            <SpeechControlMenu
              showMethodSelector={speechControl.showMethodSelector}
              methodOptions={speechControl.methodOptions}
              selectedMethod={selectedSpeechMethod}
              onMethodChange={speechControl.onMethodChange}
              smartTurnSettings={speechControl.smartTurnSettings}
              onSmartTurnSettingsChange={
                speechControl.onSmartTurnSettingsChange
              }
              smartTurnDisabled={speechControl.smartTurnDisabled}
              onBeforeOpen={() => {
                if (speechControl.voiceButton?.kind !== "live") return;
                speechControl.voiceButton.onListeningStop?.();
                speechControl.voiceButton.ref?.current?.stopAndFinalize();
                speechControl.voiceButton.onInterimTranscript("");
              }}
              onBeforeCaptureChange={() => {
                if (speechControl.voiceButton?.kind !== "live") return;
                speechControl.voiceButton.onListeningStop?.();
                speechControl.voiceButton.ref?.current?.stopAndFinalize();
                speechControl.voiceButton.onInterimTranscript("");
              }}
              onPointerNearTrigger={() =>
                speechControl.voiceButton?.kind === "live"
                  ? speechControl.voiceButton.ref?.current?.prewarm?.()
                  : undefined
              }
              trigger={
                <VoiceInputButton
                  ref={speechControl.voiceButton.ref}
                  onTranscript={speechControl.voiceButton.onTranscript}
                  onInterimTranscript={
                    speechControl.voiceButton.onInterimTranscript
                  }
                  onListeningStart={speechControl.voiceButton.onListeningStart}
                  onListeningStop={speechControl.voiceButton.onListeningStop}
                  onPendingSpeechChange={
                    speechControl.voiceButton.onPendingSpeechChange
                  }
                  onTranscriptionSettled={
                    speechControl.voiceButton.onTranscriptionSettled
                  }
                  disabled={speechControl.voiceButton.disabled}
                  speechMethod={speechControl.voiceButton.speechMethod}
                  getTranscriptionContext={
                    speechControl.voiceButton.getTranscriptionContext
                  }
                  smartTurn={speechControl.voiceButton.smartTurn}
                  showWaveform={speechControl.voiceButton.showWaveform}
                />
              }
            />
          )}
        {speechWaveformActive && <SpeechWaveform />}
      </div>
      {renderStatusAges(
        visibility.sessionStatus
          ? inlineTierClass("sessionStatus", "composer-status-ages")
          : "composer-status-ages",
        refs?.status,
      )}
      {hasBottomOverflowControls && bottomOverflowTier !== "none" && (
        <div
          className={`composer-bottom-overflow ${
            bottomOverflowOpen ? "is-open" : ""
          }`}
        >
          <button
            type="button"
            className="composer-bottom-overflow-button"
            aria-label={t("toolbarOverflowMenu")}
            aria-expanded={bottomOverflowOpen}
            onClick={() => setBottomOverflowOpen((open) => !open)}
          >
            ...
          </button>
          {bottomOverflowOpen && (
            <div className="composer-bottom-overflow-menu" role="menu">
              <div className="composer-bottom-overflow-menu-group composer-bottom-overflow-menu-left">
                {visibility.modeSelector &&
                  modeControl &&
                  isPriorityCollapsible("modeSelector") && (
                    <span className={menuTierClass("modeSelector")}>
                      <ModeSelector
                        mode={modeControl.mode}
                        onModeChange={modeControl.onModeChange}
                        modes={modeControl.modes}
                        changesApplyNextTurn={modeControl.changesApplyNextTurn}
                        modeChangePending={modeControl.modeChangePending}
                      />
                    </span>
                  )}
                {visibility.attachments &&
                  isPriorityCollapsible("attachments") && (
                    <button
                      type="button"
                      className={menuTierClass("attachments", "attach-button")}
                      onClick={attachmentControl.onAttachClick}
                      disabled={!attachmentControl.canAttach}
                      title={
                        attachmentControl.canAttach
                          ? t("toolbarAttachFiles")
                          : t("toolbarAttachDisabled")
                      }
                      role="menuitem"
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        aria-hidden="true"
                      >
                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                      </svg>
                      {attachmentControl.attachmentCount > 0 && (
                        <span className="attach-count">
                          {attachmentControl.attachmentCount}
                        </span>
                      )}
                    </button>
                  )}
                {visibility.sessionStatus &&
                  isPriorityCollapsible("sessionStatus") &&
                  renderStatusAges(
                    menuTierClass(
                      "sessionStatus",
                      "composer-status-ages",
                      "composer-status-ages--menu",
                    ),
                  )}
              </div>
              <div className="composer-bottom-overflow-menu-group composer-bottom-overflow-menu-right">
                {visibility.slashMenu &&
                  slashControl &&
                  isPriorityCollapsible("slashMenu") && (
                    <span className={menuTierClass("slashMenu")}>
                      <SlashCommandButton
                        commands={slashControl.commands}
                        onSelectCommand={slashControl.onSelectCommand}
                        disabled={slashControl.disabled}
                      />
                    </span>
                  )}
                {visibility.thinkingToggle &&
                  thinkingControl &&
                  isPriorityCollapsible("thinkingToggle") && (
                    <span className={menuTierClass("thinkingToggle")}>
                      <ThinkingToolbarControl control={thinkingControl} t={t} />
                    </span>
                  )}
                {visibility.renderMode &&
                  renderModeControl &&
                  isPriorityCollapsible("renderMode") && (
                    <button
                      type="button"
                      className={menuTierClass(
                        "renderMode",
                        "render-mode-toolbar-button",
                        renderModeControl.state === "rendered"
                          ? "is-rendered"
                          : renderModeControl.state === "mixed"
                            ? "is-mixed"
                            : "",
                      )}
                      onClick={renderModeControl.onToggle}
                      title={renderModeControl.title}
                      aria-label={renderModeControl.title}
                      role="menuitemcheckbox"
                      aria-checked={
                        renderModeControl.state === "mixed"
                          ? "mixed"
                          : renderModeControl.state === "rendered"
                      }
                    >
                      <RenderModeGlyph />
                    </button>
                  )}
                {visibility.conversationView &&
                  conversationViewControl &&
                  isPriorityCollapsible("conversationView") && (
                    <button
                      type="button"
                      className={menuTierClass(
                        "conversationView",
                        "conversation-view-toolbar-button",
                        conversationViewControl.enabled ? "active" : "",
                      )}
                      onClick={conversationViewControl.onToggle}
                      title={conversationViewControl.title}
                      aria-label={conversationViewControl.title}
                      role="menuitemcheckbox"
                      aria-checked={conversationViewControl.enabled}
                    >
                      <ConversationViewIcon />
                    </button>
                  )}
                {visibility.nudge &&
                  nudgeControl &&
                  isPriorityCollapsible("nudge") && (
                    <button
                      type="button"
                      className={menuTierClass(
                        "nudge",
                        "heartbeat-toolbar-button",
                        nudgeControl.enabled ? "active" : "",
                      )}
                      onClick={nudgeControl.onClick}
                      onContextMenu={nudgeControl.onContextMenu}
                      onTouchStart={nudgeControl.onTouchStart}
                      onTouchEnd={nudgeControl.onTouchEnd}
                      onTouchCancel={nudgeControl.onClearTouch}
                      onTouchMove={nudgeControl.onClearTouch}
                      title={nudgeControl.title}
                      aria-label={nudgeControl.title}
                      role="menuitemcheckbox"
                      aria-checked={nudgeControl.enabled}
                    >
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="miter"
                        aria-hidden="true"
                      >
                        <path className="heartbeat-baseline" d="M0.75 15H7" />
                        <path
                          className="heartbeat-excursion"
                          d="M7 15l2-5 2 9 4-16 3 12"
                        />
                        <path className="heartbeat-baseline" d="M18 15h5.25" />
                      </svg>
                    </button>
                  )}
                {visibility.shortcutsHelp &&
                  isPriorityCollapsible("shortcutsHelp") && (
                    <button
                      type="button"
                      className={menuTierClass(
                        "shortcutsHelp",
                        "session-shortcuts-help-button",
                      )}
                      aria-label={t("toolbarKeyboardShortcutsAria")}
                      aria-expanded={shortcutsPopoverOpen}
                      onClick={() => shortcutsControl.setOpen((open) => !open)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        openShortcutSettings();
                      }}
                      onTouchStart={startShortcutsLongPress}
                      onTouchEnd={clearShortcutsLongPress}
                      onTouchCancel={clearShortcutsLongPress}
                      onTouchMove={clearShortcutsLongPress}
                      role="menuitem"
                    >
                      ?
                    </button>
                  )}
                {isPriorityCollapsible("contextUsage") &&
                  renderContextUsage(
                    menuTierClass("contextUsage", "context-toolbar-control"),
                  )}
                {isPriorityCollapsible("btw") &&
                  renderBtwButton(
                    menuTierClass(
                      "btw",
                      "btw-toolbar-button",
                      actionsControl.btw?.pressed ? "active" : "",
                      actionsControl.btw?.mode === "focus-existing"
                        ? "has-asides"
                        : "",
                    ),
                    true,
                  )}
                {isPriorityCollapsible("steerNow") &&
                  renderSteerNowToggle(
                    menuTierClass("steerNow", "steer-now-toggle"),
                  )}
                {renderProjectQueueButtons(true)}
              </div>
            </div>
          )}
        </div>
      )}
      <div ref={refs?.actions} className="message-input-actions">
        {pendingApproval && (
          <button
            type="button"
            className={`pending-approval-indicator ${pendingApproval.type}`}
            onClick={pendingApproval.onExpand}
            title={
              pendingApproval.type === "tool-approval"
                ? t("toolbarPendingApprovalExpand")
                : t("toolbarPendingQuestionExpand")
            }
          >
            <span className="pending-approval-dot" />
            <span className="pending-approval-text">
              {pendingApproval.type === "tool-approval"
                ? t("toolbarApproval")
                : t("toolbarQuestion")}
            </span>
          </button>
        )}
        {visibility.shortcutsHelp && (
          // biome-ignore lint/a11y/noStaticElementInteractions: pointer leave only hides the adjacent shortcuts popover
          <div
            className={inlineTierClass(
              "shortcutsHelp",
              "session-shortcuts-help",
            )}
            onMouseLeave={() => {
              shortcutsControl.setOpen(false);
              shortcutsControl.setSettingsOpen(false);
            }}
          >
            <button
              type="button"
              className="session-shortcuts-help-button"
              aria-label={t("toolbarKeyboardShortcutsAria")}
              aria-expanded={shortcutsPopoverOpen}
              onClick={() => shortcutsControl.setOpen((open) => !open)}
              onContextMenu={(event) => {
                event.preventDefault();
                openShortcutSettings();
              }}
              onFocus={() => shortcutsControl.setOpen(true)}
              onBlur={(event) => {
                if (
                  !event.currentTarget.parentElement?.contains(
                    event.relatedTarget as Node | null,
                  )
                ) {
                  shortcutsControl.setOpen(false);
                }
              }}
              onMouseEnter={() => shortcutsControl.setOpen(true)}
              onTouchStart={startShortcutsLongPress}
              onTouchEnd={clearShortcutsLongPress}
              onTouchCancel={clearShortcutsLongPress}
              onTouchMove={clearShortcutsLongPress}
            >
              ?
            </button>
            {shortcutsPopoverOpen && (
              <div
                className={`session-shortcuts-popover ${
                  shortcutsControl.isearchScope !== null
                    ? "is-isearch-guide"
                    : ""
                }`}
                role="dialog"
                aria-label={t("toolbarKeyboardShortcutsAria")}
              >
                {shortcutsControl.isearchScope !== null ? (
                  <>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        {getIsearchPreviousKeys(
                          shortcutsControl.isearchScope,
                        ).map((key) => (
                          <kbd key={key}>{key}</kbd>
                        ))}
                        {shortcutsControl.isearchScope === "user" && (
                          <>
                            <span>{t("commonOr")}</span>
                            <kbd>Ctrl</kbd>
                            <kbd>Alt</kbd>
                            <kbd>R</kbd>
                          </>
                        )}
                      </span>
                      <span>{t("toolbarShortcutPreviousMatch")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Enter</kbd>
                      </span>
                      <span>{t("toolbarShortcutJump")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>↑</kbd>
                        <kbd>↓</kbd>
                      </span>
                      <span>{t("toolbarShortcutPreviousNextMatch")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        {t("toolbarShortcutClick")}
                      </span>
                      <span>{t("toolbarShortcutPreviewRailJumps")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Esc</kbd>
                      </span>
                      <span>{t("toolbarShortcutCancelRestoreFocus")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>End</kbd>
                      </span>
                      <span>{t("toolbarShortcutScrollToCurrent")}</span>
                    </div>
                    {getIsearchAlternateRows(
                      shortcutsControl.isearchScope,
                      t,
                    ).map((row) => (
                      <div key={row.label} className="session-shortcuts-row">
                        <span className="session-shortcuts-keys">
                          {row.keys.map((key) => (
                            <kbd key={key}>{key}</kbd>
                          ))}
                          {row.scope === "user" && (
                            <>
                              <span>{t("commonOr")}</span>
                              <kbd>Ctrl</kbd>
                              <kbd>Alt</kbd>
                              <kbd>R</kbd>
                            </>
                          )}
                        </span>
                        <span>{row.label}</span>
                      </div>
                    ))}
                  </>
                ) : (
                  <>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>R</kbd>
                        <span>{t("commonOr")}</span>
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>R</kbd>
                      </span>
                      <span>{t("toolbarShortcutUserTurnReverseSearch")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>S</kbd>
                      </span>
                      <span>{t("toolbarShortcutAllTurnReverseSearch")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Alt</kbd>
                        <kbd>S</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutFullSessionReverseSearch")}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Enter</kbd>
                      </span>
                      <span>
                        {shortcutsControl.hasDualActions
                          ? t("toolbarShortcutSteerCurrentTurn")
                          : t("toolbarShortcutSend")}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Shift</kbd>
                        <kbd>Enter</kbd>
                      </span>
                      <span>{t("toolbarShortcutNewLine")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Enter</kbd>
                      </span>
                      <span>{shortcutsControl.queueShortcutLabel}</span>
                    </div>
                    {shortcutsControl.canForkAfterSummary && (
                      <div className="session-shortcuts-row">
                        <span className="session-shortcuts-keys">
                          <kbd>Ctrl</kbd>
                          <kbd>Alt</kbd>
                          <kbd>Enter</kbd>
                        </span>
                        <span>{t("toolbarShortcutForkAfterSummary")}</span>
                      </div>
                    )}
                    {shortcutSettings && (
                      <div className="session-shortcuts-row session-shortcuts-row-muted">
                        <span className="session-shortcuts-keys">
                          {t("toolbarShortcutRightClickLongPress")}
                        </span>
                        <span>{t("toolbarShortcutChangeKeys")}</span>
                      </div>
                    )}
                    {shortcutsControl.settingsOpen && shortcutSettings && (
                      <div className="session-shortcuts-settings">
                        <div className="session-shortcuts-row">
                          <span className="session-shortcuts-keys">
                            <kbd>Enter</kbd>
                          </span>
                          <span>
                            {shortcutsControl.enterActionKind === "queue"
                              ? t("toolbarShortcutQueueCurrentTurn")
                              : t("toolbarShortcutSteerCurrentTurn")}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="session-shortcuts-action"
                          onClick={shortcutSettings.onSwapEnterAction}
                        >
                          {t("toolbarShortcutSwapEnterCtrlEnter")}
                        </button>
                      </div>
                    )}
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>B</kbd>
                      </span>
                      <span>{t("toolbarShortcutStartBtwAside")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Esc</kbd>
                      </span>
                      <span>{t("toolbarShortcutStopAgentCancelOverlay")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>P</kbd>
                      </span>
                      <span>{t("toolbarShortcutRecallLastSentText")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>K</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutCancelLatestQueuedMessage")}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>O</kbd>
                      </span>
                      <span>
                        {t("toolbarShortcutToggleThinkingTranscript")}
                      </span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>End</kbd>
                      </span>
                      <span>{t("toolbarShortcutScrollToCurrent")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>G</kbd>
                      </span>
                      <span>{t("toolbarShortcutClearComposer")}</span>
                    </div>
                    <div className="session-shortcuts-row">
                      <span className="session-shortcuts-keys">
                        <kbd>Ctrl</kbd>
                        <kbd>Shift</kbd>
                        <kbd>M</kbd>
                      </span>
                      <span>{t("toolbarShortcutRenderedSourceMode")}</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        )}
        {renderContextUsage(
          inlineTierClass("contextUsage", "context-toolbar-control"),
        )}
        {renderBtwButton(
          inlineTierClass(
            "btw",
            "btw-toolbar-button",
            actionsControl.btw?.pressed ? "active" : "",
            actionsControl.btw?.mode === "focus-existing" ? "has-asides" : "",
          ),
        )}
        {showStopButton && actionsControl.stop && (
          <button
            type="button"
            onClick={actionsControl.stop.onStop}
            className="stop-button"
            aria-label={t("toolbarStop")}
            title={actionsControl.stop.title}
          >
            <span className="stop-icon" />
          </button>
        )}
        {showActionsControl && actionsControl.send ? (
          <>
            {renderSteerNowToggle(
              inlineTierClass("steerNow", "steer-now-toggle"),
            )}
            {!hidePrimaryDeliveryActions &&
              queueControl?.hasDualActions &&
              actionsControl.send.primaryActionKind !== "queue" &&
              queueControl.onQueue && (
                <button
                  type="button"
                  onClick={queueControl.onQueue}
                  disabled={
                    actionsControl.disabled || !actionsControl.send.canSend
                  }
                  className="send-button queue-button"
                  aria-label={
                    actionsControl.send.speechMessagePrefix
                      ? t("speechPrefixDeliveryLabel", {
                          action: t("toolbarQueueLabel"),
                          prefix: actionsControl.send.speechMessagePrefix,
                        })
                      : t("toolbarQueueLabel")
                  }
                  title={
                    actionsControl.send.speechMessagePrefix
                      ? t("speechPrefixDeliveryTooltip", {
                          tooltip: queueControl.queueTooltip,
                          prefix: actionsControl.send.speechMessagePrefix,
                        })
                      : queueControl.queueTooltip
                  }
                >
                  <span className="send-icon queue-icon">→</span>
                  {actionsControl.send.speechMessagePrefix && (
                    <SpeechPrefixActionCue
                      prefix={actionsControl.send.speechMessagePrefix}
                    />
                  )}
                </button>
              )}
            {!hidePrimaryDeliveryActions &&
              queueControl?.hasDualActions &&
              actionsControl.send.primaryActionKind === "queue" &&
              queueControl.onSteer && (
                <button
                  type="button"
                  onClick={queueControl.onSteer}
                  disabled={
                    actionsControl.disabled || !actionsControl.send.canSend
                  }
                  className="send-button steer-button"
                  aria-label={
                    actionsControl.send.speechMessagePrefix
                      ? t("speechPrefixDeliveryLabel", {
                          action: t("toolbarSteerTooltip"),
                          prefix: actionsControl.send.speechMessagePrefix,
                        })
                      : t("toolbarSteerTooltip")
                  }
                  title={
                    actionsControl.send.speechMessagePrefix
                      ? t("speechPrefixDeliveryTooltip", {
                          tooltip: t("toolbarSteerTooltip"),
                          prefix: actionsControl.send.speechMessagePrefix,
                        })
                      : t("toolbarSteerTooltip")
                  }
                >
                  <span className="send-icon">↗</span>
                  {actionsControl.send.speechMessagePrefix && (
                    <SpeechPrefixActionCue
                      prefix={actionsControl.send.speechMessagePrefix}
                    />
                  )}
                </button>
              )}
            {!hidePrimaryDeliveryActions && actionsControl.send.alternate && (
              <button
                type="button"
                onClick={actionsControl.send.alternate.onClick}
                disabled={
                  actionsControl.disabled || !actionsControl.send.canSend
                }
                className="send-button fork-summary-no-summary-button"
                aria-label={
                  actionsControl.send.speechMessagePrefix
                    ? t("speechPrefixDeliveryLabel", {
                        action: actionsControl.send.alternate.label,
                        prefix: actionsControl.send.speechMessagePrefix,
                      })
                    : actionsControl.send.alternate.label
                }
                title={
                  actionsControl.send.speechMessagePrefix
                    ? t("speechPrefixDeliveryTooltip", {
                        tooltip: actionsControl.send.alternate.tooltip,
                        prefix: actionsControl.send.speechMessagePrefix,
                      })
                    : actionsControl.send.alternate.tooltip
                }
              >
                <span className="send-icon">
                  {actionsControl.send.alternate.icon}
                </span>
                {actionsControl.send.speechMessagePrefix && (
                  <SpeechPrefixActionCue
                    prefix={actionsControl.send.speechMessagePrefix}
                  />
                )}
              </button>
            )}
            {renderProjectQueueButtons()}
            {showSendButton && (
              <button
                type="button"
                onClick={actionsControl.send?.onSend}
                disabled={
                  actionsControl.disabled || !actionsControl.send.canSend
                }
                className={`send-button send-button-with-help ${
                  actionsControl.send.primaryActionKind === "queue"
                    ? "queue-mode"
                    : ""
                }`}
                aria-label={
                  actionsControl.send.primarySpeechMessagePrefix
                      ? t("speechPrefixDeliveryLabel", {
                          action: actionsControl.send.primaryActionLabel,
                          prefix: actionsControl.send.primarySpeechMessagePrefix,
                        })
                    : actionsControl.send.primaryActionLabel
                }
                {...getTextTooltipAttributes(
                  actionsControl.send.primarySpeechMessagePrefix
                      ? t("speechPrefixDeliveryTooltip", {
                          tooltip: actionsControl.send.tooltip,
                          prefix: actionsControl.send.primarySpeechMessagePrefix,
                        })
                    : actionsControl.send.tooltip,
                  tooltipMode,
                )}
              >
                <span className="send-icon">{actionsControl.send.icon}</span>
                {actionsControl.send.primarySpeechMessagePrefix && (
                  <SpeechPrefixActionCue
                    prefix={actionsControl.send.primarySpeechMessagePrefix}
                  />
                )}
              </button>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function MessageInputToolbar({
  mode = "default",
  onModeChange,
  modeChangesApplyNextTurn,
  modeChangePending,
  supportsPermissionMode = true,
  supportsThinkingToggle = true,
  canAttach,
  attachmentCount = 0,
  onAttachClick,
  voiceButtonRef,
  onVoiceTranscript,
  onInterimTranscript,
  onListeningStart,
  onListeningStop,
  onPendingSpeechChange,
  onTranscriptionSettled,
  voiceDisabled,
  getTranscriptionContext,
  slashCommands = [],
  onSelectSlashCommand,
  onBtwClick,
  btwActive = false,
  btwHasAsides = false,
  btwToolbarMode,
  thinkingProvider,
  thinkingModel,
  liveThinkingSelection,
  contextRequestedModel,
  heartbeatEnabled = false,
  onToggleHeartbeat,
  onConfigureHeartbeat,
  contextUsage,
  lastActivityAt,
  positionTimestampMs,
  sessionLiveness,
  providerRuntimeStatus,
  showSteerNowMode = false,
  steerNowEnabled = false,
  onToggleSteerNow,
  enterActionKind,
  canSwapEnterAction = false,
  onSwapEnterAction,
  isRunning,
  isThinking,
  onStop,
  onSend,
  onQueue,
  onProjectQueue,
  onProjectQueueNewSession,
  onSteer,
  primaryActionKind,
  sendOverride,
  sendAlternate,
  canForkAfterSummary,
  canSend,
  speechMessagePrefix,
  primarySpeechMessagePrefix,
  disabled,
  hidePrimaryDeliveryActions = false,
  hideVoiceInput = false,
  pendingApproval,
}: MessageInputToolbarProps) {
  const { t } = useI18n();
  const {
    thinkingMode,
    thinkingLevel,
    setThinkingMode,
    setEffortLevel,
    showThinking = "default",
    setShowThinking,
    voiceInputEnabled = true,
    speechMethod = "browser-native",
    hasStoredSpeechMethod = false,
    setSpeechMethod,
    speechSmartTurnSettings,
    setSpeechSmartTurnSettings,
  } = useModelSettings();
  const { version: versionInfo } = useVersion();
  const supportsProjectQueue = serverSupportsProjectQueue(versionInfo);
  const { providers } = useProviders();
  const { visibility: toolbarVisibility, priority: toolbarPriority } =
    useSessionToolbarPresence();
  const { conversationViewEnabled, setConversationViewEnabled } =
    useConversationView();
  const renderMode = useOptionalRenderModeContext();
  const nowMs = useRelativeNow();
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [shortcutSettingsOpen, setShortcutSettingsOpen] = useState(false);
  const [isearchScope, setIsearchScope] = useState<SessionIsearchScope | null>(
    null,
  );
  const [speechCaptureActive, setSpeechCaptureActive] = useState(false);
  const lastNonOffThinkingModeRef =
    useRef<Exclude<ThinkingMode, "off">>("auto");
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const toolbarLeftRef = useRef<HTMLDivElement | null>(null);
  const toolbarStatusRef = useRef<HTMLDivElement | null>(null);
  const toolbarActionsRef = useRef<HTMLDivElement | null>(null);
  const selectedThinkingMode = liveThinkingSelection?.mode ?? thinkingMode;
  const selectedThinkingLevel = liveThinkingSelection?.level ?? thinkingLevel;
  const setSelectedThinkingMode =
    liveThinkingSelection?.onSetMode ?? setThinkingMode;
  const setSelectedEffortLevel =
    liveThinkingSelection?.onSetEffort ?? setEffortLevel;
  const [isCompactStatusMode, setIsCompactStatusMode] = useState(() =>
    typeof window === "undefined"
      ? false
      : (getCompactStatusMatchMedia()?.matches ?? false),
  );
  const normalizedThinkingProvider = useMemo(
    () => normalizeProviderKey(thinkingProvider),
    [thinkingProvider],
  );
  const thinkingProviderInfo = useMemo(
    () =>
      providers.find(
        (provider) => provider.name === normalizedThinkingProvider,
      ) ?? null,
    [normalizedThinkingProvider, providers],
  );
  const thinkingModelInfo = useMemo<ModelInfo | null>(
    () =>
      thinkingProviderInfo?.models?.find(
        (model) => model.id === thinkingModel,
      ) ?? null,
    [thinkingModel, thinkingProviderInfo],
  );
  const thinkingEffortOptions = useMemo(
    () =>
      getEffortLevelOptions({
        provider:
          thinkingProviderInfo ?? (normalizedThinkingProvider as ProviderName),
        model: thinkingModelInfo ?? thinkingModel,
        translate: t,
      }),
    [
      thinkingModel,
      thinkingModelInfo,
      thinkingProviderInfo,
      normalizedThinkingProvider,
      t,
    ],
  );
  const effectiveThinkingLevel = useMemo(
    () =>
      resolveSupportedEffortLevel(selectedThinkingLevel, thinkingEffortOptions),
    [selectedThinkingLevel, thinkingEffortOptions],
  );
  const thinkingModeOptions = useMemo(
    () =>
      getThinkingModeOptions({
        provider:
          thinkingProviderInfo ?? (normalizedThinkingProvider as ProviderName),
        model: thinkingModelInfo ?? thinkingModel,
        effortOptions: thinkingEffortOptions,
      }),
    [
      thinkingEffortOptions,
      thinkingModel,
      thinkingModelInfo,
      thinkingProviderInfo,
      normalizedThinkingProvider,
    ],
  );
  const effectiveThinkingMode = useMemo(
    () =>
      resolveSupportedThinkingMode(selectedThinkingMode, thinkingModeOptions),
    [selectedThinkingMode, thinkingModeOptions],
  );
  const permissionModeOptions = useMemo(
    () =>
      getPermissionModeOptions({
        model: thinkingModelInfo,
        currentMode: mode,
      }),
    [mode, thinkingModelInfo],
  );
  const hasThinkingModeOptions = thinkingModeOptions.some(
    (option) => option !== "off",
  );
  const lastActivityMs = parseTimestampMs(lastActivityAt);
  const showLastActivityAge = isStaleTimestamp(lastActivityMs, nowMs);
  const lastActivityAgeMs =
    lastActivityMs === null ? null : nowMs - lastActivityMs;
  // Keep the long "Last activity 35m" prefix exclusive to the inline row.
  const statusFloats = isCompactStatusMode || !toolbarVisibility.sessionStatus;
  const showLastActivityPrefix =
    showLastActivityAge &&
    !statusFloats &&
    lastActivityAgeMs !== null &&
    lastActivityAgeMs >= LAST_ACTIVITY_TEXT_PREFIX_THRESHOLD_MS;
  const lastActivityIsPast =
    showLastActivityAge &&
    !showLastActivityPrefix &&
    lastActivityMs !== null &&
    formatCompactRelativeAge(lastActivityMs, nowMs) !== "now";
  const positionAgeLabel =
    positionTimestampMs === null || positionTimestampMs === undefined
      ? null
      : formatCompactRelativeAge(positionTimestampMs, nowMs);
  const lastActivityAgeLabel =
    lastActivityMs === null
      ? null
      : formatCompactRelativeAge(lastActivityMs, nowMs);
  // Age *content* independent of the sessionStatus toggle. The compact
  // "float over the composer" presentation reuses these so width-constrained
  // clients (mobile defaults sessionStatus off) still get the ages; the
  // sessionStatus toggle gates only the inline row + liveness chip.
  // "at N ago" stays follow-mode-safe: positionTimestampMs is null at the
  // scroll bottom (MessageList), so hasPositionAge is false in follow mode.
  // A current position ("now") always counts as duplicating the session
  // freshness, even when the freshness label is missing or suppressed as
  // current, so it never earns a chip.
  const hasPositionAge =
    positionTimestampMs !== null &&
    positionTimestampMs !== undefined &&
    positionAgeLabel !== null &&
    positionAgeLabel !== "now" &&
    positionAgeLabel !== lastActivityAgeLabel;
  const showPositionTimestamp =
    toolbarVisibility.sessionStatus && hasPositionAge;
  const livenessDisplay = sessionLiveness
    ? describeSessionLiveness(sessionLiveness, t)
    : null;
  const providerRuntimeDisplay = describeProviderRuntimeStatus(
    providerRuntimeStatus ?? null,
    t,
  );
  const showLivenessChip =
    toolbarVisibility.sessionStatus &&
    !providerRuntimeDisplay &&
    !!livenessDisplay &&
    !(
      showLastActivityAge &&
      (isCompactStatusMode ||
        livenessDisplay.tone === "ok" ||
        livenessDisplay.tone === "muted")
    );
  const livenessSummary = livenessDisplay
    ? describeLivenessSummary(t, livenessDisplay, nowMs)
    : null;
  const heartbeatLongPressTimerRef = useRef<ReturnType<
    typeof setTimeout
  > | null>(null);
  const suppressHeartbeatClickRef = useRef(false);
  const renderModeTitle =
    renderMode?.state === "rendered"
      ? t("toolbarRenderModeRendered")
      : renderMode?.state === "source"
        ? t("toolbarRenderModeSource")
        : t("toolbarRenderModeMixed");
  const conversationViewTitle = conversationViewEnabled
    ? t("toolbarConversationViewDisable")
    : t("toolbarConversationViewEnable");
  const hasPotentialDualActions = !!(onSend && onQueue && onSteer);
  const effectivePrimaryActionKind =
    primaryActionKind ?? (hasPotentialDualActions ? "steer" : "send");
  const hasDualActions =
    hasPotentialDualActions &&
    (effectivePrimaryActionKind === "steer" ||
      effectivePrimaryActionKind === "queue");
  const queueActionTooltip = t("toolbarQueueTooltip");
  const projectQueueCtrlEnterEnabled =
    versionInfo?.clientDefaults?.projectQueueCtrlEnterEnabled ??
    DEFAULT_PROJECT_QUEUE_CTRL_ENTER_ENABLED;
  const showProjectQueueShortcut = Boolean(
    supportsProjectQueue &&
      toolbarVisibility.projectQueue &&
      onProjectQueue &&
      projectQueueCtrlEnterEnabled,
  );
  const sendTooltip = sendOverride
    ? sendOverride.tooltip
    : effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? queueActionTooltip
        : t("toolbarSendTooltip");
  const queueTooltip = queueActionTooltip;
  const canSwapDisplayedEnterAction =
    canSwapEnterAction && !showProjectQueueShortcut;
  const queueShortcutLabel = showProjectQueueShortcut
    ? t("toolbarShortcutProjectQueue")
    : canSwapDisplayedEnterAction && effectivePrimaryActionKind === "queue"
      ? t("toolbarShortcutSteerCurrentTurn")
      : t("toolbarShortcutQueueCurrentTurn");
  const effectiveBtwToolbarMode =
    btwToolbarMode ??
    (btwActive ? "focused-footer" : btwHasAsides ? "focus-existing" : "start");
  const btwTitle = getBtwTitle(effectiveBtwToolbarMode, t);
  const btwPressed = isBtwPressed(effectiveBtwToolbarMode);
  const primaryActionIcon = sendOverride
    ? sendOverride.icon
    : effectivePrimaryActionKind === "steer"
      ? "↗"
      : effectivePrimaryActionKind === "queue"
        ? "→"
        : "↑";
  const primaryActionLabel = sendOverride
    ? sendOverride.label
    : effectivePrimaryActionKind === "steer"
      ? t("toolbarSteerTooltip")
      : effectivePrimaryActionKind === "queue"
        ? hasDualActions
          ? t("toolbarQueuePrimaryActionLabel")
          : t("toolbarQueueLabel")
        : t("toolbarSend");
  const stopTitle = `${t("toolbarStop")} (Esc)`;
  const showStopButton = !!(isRunning && onStop && isThinking && !canSend);
  const showSendButton = !!(onSend && (!showStopButton || canSend));
  const serverVoiceEnabled =
    versionInfo?.capabilities === undefined
      ? true
      : serverHasCapability(versionInfo, VOICE_INPUT_CAPABILITY);
  const { hasBrowserXaiSttApiKey } = useBrowserXaiSttApiKey();
  const speechMethodOptions = useMemo((): FilterOption<SpeechMethodId>[] => {
    const serverBackends = versionInfo?.voiceBackends ?? [];
    return getSpeechMethods(serverBackends, undefined, {
      directXaiAvailable: hasBrowserXaiSttApiKey,
    }).map((method) => ({
      value: method.id,
      label: method.label,
      description: method.description,
      disabled: !method.clientSupported,
    }));
  }, [versionInfo?.voiceBackends, hasBrowserXaiSttApiKey]);
  const selectedSpeechMethod = useMemo(
    () =>
      resolveSpeechMethod(
        speechMethod,
        versionInfo?.voiceBackends,
        hasStoredSpeechMethod,
        {
          directXaiAvailable: hasBrowserXaiSttApiKey,
          browserNativeAvailable: isBrowserNativeSpeechAvailable(),
        },
      ),
    [
      speechMethod,
      versionInfo?.voiceBackends,
      hasStoredSpeechMethod,
      hasBrowserXaiSttApiKey,
    ],
  );
  const handleSpeechMethodSelect = useCallback(
    (selected: string[]) => {
      const next = selected[0];
      if (next && isSpeechMethodId(next)) {
        setSpeechMethod?.(next);
      }
    },
    [setSpeechMethod],
  );
  const showSpeechMethodSelector =
    toolbarVisibility.microphone &&
    voiceInputEnabled &&
    serverVoiceEnabled &&
    speechMethodOptions.length > 1;
  const selectedSpeechMethodCapabilities = getSpeechMethodCapabilities(
    selectedSpeechMethod,
    versionInfo?.voiceBackendCapabilities,
  );
  const selectedSpeechCanStream = canSpeechMethodStream({
    methodId: selectedSpeechMethod,
    serverCapabilities: versionInfo?.voiceBackendCapabilities,
  });
  const supportsSelectedSpeechSmartTurn =
    selectedSpeechCanStream &&
    selectedSpeechMethodCapabilities.smartTurn === true;
  const activeSpeechSmartTurnSettings: SpeechSmartTurnSettings | undefined =
    supportsSelectedSpeechSmartTurn ? speechSmartTurnSettings : undefined;
  const hasLastActivityAge = showLastActivityAge;
  const showLastActivityChip =
    toolbarVisibility.sessionStatus && hasLastActivityAge;
  const showToolbarStatus =
    showLivenessChip || showLastActivityChip || showPositionTimestamp;
  const compactStatusLayoutKey = [
    livenessDisplay?.prefix ?? "",
    livenessDisplay?.timestampMs ?? "",
    livenessDisplay?.tone ?? "",
    nowMs,
    showLastActivityAge,
    showLastActivityChip,
    showLivenessChip,
    showToolbarStatus,
    showPositionTimestamp,
    showStopButton,
    showSendButton,
  ].join("\0");

  useEffect(() => {
    if (effectiveThinkingMode !== "off") {
      lastNonOffThinkingModeRef.current = effectiveThinkingMode;
    }
  }, [effectiveThinkingMode]);

  const toggleThinkingEnabled = useCallback(() => {
    const nextEnabledMode = thinkingModeOptions.includes(
      lastNonOffThinkingModeRef.current,
    )
      ? lastNonOffThinkingModeRef.current
      : (thinkingModeOptions.find((option) => option !== "off") ?? "auto");
    setSelectedThinkingMode(
      effectiveThinkingMode === "off" ? nextEnabledMode : "off",
    );
  }, [effectiveThinkingMode, setSelectedThinkingMode, thinkingModeOptions]);
  const setSelectedThinkingEffortMode = useCallback(
    (level: EffortLevel) => {
      if (liveThinkingSelection) {
        liveThinkingSelection.onSetEffort(level);
        return;
      }
      setSelectedEffortLevel(level);
      setSelectedThinkingMode("on");
    },
    [liveThinkingSelection, setSelectedEffortLevel, setSelectedThinkingMode],
  );

  useLayoutEffect(() => {
    void compactStatusLayoutKey;
    const compactStatusQuery = getCompactStatusMatchMedia();
    const toolbar = toolbarRef.current;
    const left = toolbarLeftRef.current;
    const actions = toolbarActionsRef.current;

    if (!toolbar || !left || !actions || typeof window === "undefined") {
      setIsCompactStatusMode(compactStatusQuery?.matches ?? false);
      return;
    }

    let raf = 0;

    const pxOrZero = (value: string) => {
      const parsed = Number.parseFloat(value);
      return Number.isFinite(parsed) ? parsed : 0;
    };

    // Content demand of a toolbar section, immune to flex stretching. A
    // stretched section reports its grown size through scrollWidth:
    // .message-input-left is flex: 1, so once the status floats (leaving the
    // row) the left section absorbs the freed room, and measuring rendered
    // sizes feeds that growth back into requiredWidth — compact mode then
    // stays latched at any window width. Children that are themselves
    // stretchy fillers (flex-grow, e.g. the speech waveform) count as their
    // flex basis.
    const sectionDemand = (section: HTMLElement) => {
      const styles = getComputedStyle(section);
      const gap = pxOrZero(styles.columnGap || styles.gap);
      let width = 0;
      let inFlow = 0;
      for (const child of Array.from(section.children)) {
        if (!(child instanceof HTMLElement)) {
          continue;
        }
        const childStyles = getComputedStyle(child);
        if (
          childStyles.display === "none" ||
          childStyles.position === "absolute"
        ) {
          continue;
        }
        inFlow += 1;
        width +=
          pxOrZero(childStyles.flexGrow) > 0
            ? pxOrZero(childStyles.flexBasis)
            : child.getBoundingClientRect().width;
      }
      return width + gap * Math.max(0, inFlow - 1);
    };

    const updateCompactStatusMode = () => {
      const status = toolbarStatusRef.current;
      const viewportCompact = compactStatusQuery?.matches ?? false;

      if (!status) {
        setIsCompactStatusMode(viewportCompact);
        return;
      }

      const toolbarStyles = getComputedStyle(toolbar);
      const gap = pxOrZero(toolbarStyles.columnGap || toolbarStyles.gap);
      const requiredWidth =
        sectionDemand(left) +
        sectionDemand(status) +
        sectionDemand(actions) +
        gap * 2;

      setIsCompactStatusMode((current) => {
        if (viewportCompact || requiredWidth > toolbar.clientWidth + 1) {
          return true;
        }
        if (!current) {
          return false;
        }
        // Exiting compact needs slack beyond merely fitting: the float omits
        // the liveness chip and restyles the ages, so demand measured while
        // floating understates the inline row it would return to. Without
        // the slack the mode can oscillate at the boundary.
        return requiredWidth + COMPACT_STATUS_EXIT_SLACK_PX >
          toolbar.clientWidth
          ? current
          : false;
      });
    };

    const scheduleCompactStatusUpdate = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(updateCompactStatusMode);
    };

    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(scheduleCompactStatusUpdate);
    resizeObserver?.observe(toolbar);
    resizeObserver?.observe(left);
    resizeObserver?.observe(actions);
    if (toolbarStatusRef.current) {
      resizeObserver?.observe(toolbarStatusRef.current);
    }

    window.addEventListener("resize", scheduleCompactStatusUpdate);
    compactStatusQuery?.addEventListener("change", scheduleCompactStatusUpdate);
    scheduleCompactStatusUpdate();

    return () => {
      window.cancelAnimationFrame(raf);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", scheduleCompactStatusUpdate);
      compactStatusQuery?.removeEventListener(
        "change",
        scheduleCompactStatusUpdate,
      );
    };
  }, [compactStatusLayoutKey]);

  useEffect(() => {
    const handleIsearchGuide = (event: Event) => {
      const detail = (event as CustomEvent<SessionIsearchGuideState>).detail;
      if (detail?.active) {
        setIsearchScope(detail.scope);
        return;
      }
      setIsearchScope(null);
      setShortcutsOpen(false);
    };

    window.addEventListener(SESSION_ISEARCH_GUIDE_EVENT, handleIsearchGuide);
    return () =>
      window.removeEventListener(
        SESSION_ISEARCH_GUIDE_EVENT,
        handleIsearchGuide,
      );
  }, []);

  const clearHeartbeatLongPress = () => {
    if (heartbeatLongPressTimerRef.current) {
      clearTimeout(heartbeatLongPressTimerRef.current);
      heartbeatLongPressTimerRef.current = null;
    }
  };

  const handleHeartbeatClick = () => {
    if (suppressHeartbeatClickRef.current) {
      suppressHeartbeatClickRef.current = false;
      return;
    }
    onToggleHeartbeat?.();
  };

  const handleHeartbeatContextMenu = (e: MouseEvent<HTMLButtonElement>) => {
    if (!onConfigureHeartbeat) return;
    e.preventDefault();
    clearHeartbeatLongPress();
    suppressHeartbeatClickRef.current = false;
    onConfigureHeartbeat();
  };

  const handleHeartbeatTouchStart = () => {
    if (!onConfigureHeartbeat) return;
    clearHeartbeatLongPress();
    suppressHeartbeatClickRef.current = false;
    heartbeatLongPressTimerRef.current = setTimeout(() => {
      suppressHeartbeatClickRef.current = true;
      heartbeatLongPressTimerRef.current = null;
      onConfigureHeartbeat();
    }, 450);
  };

  const handleHeartbeatTouchEnd = (e: TouchEvent<HTMLButtonElement>) => {
    if (suppressHeartbeatClickRef.current) {
      e.preventDefault();
    }
    clearHeartbeatLongPress();
  };

  const heartbeatTitle = t("sessionHeartbeatTitle");
  const handleToolbarPendingSpeechChange = useCallback(
    (kind: SpeechPendingKind | null, settlement?: SpeechCycleSettlement) => {
      setSpeechCaptureActive(kind === "listening");
      onPendingSpeechChange?.(kind, settlement);
    },
    [onPendingSpeechChange],
  );

  return (
    <MessageInputToolbarView
      t={t}
      refs={{
        toolbar: toolbarRef,
        left: toolbarLeftRef,
        status: toolbarStatusRef,
        actions: toolbarActionsRef,
      }}
      visibility={toolbarVisibility}
      priority={toolbarPriority}
      isCompactStatusMode={isCompactStatusMode}
      modeControl={
        onModeChange && supportsPermissionMode
          ? {
              mode,
              onModeChange,
              modes: permissionModeOptions,
              changesApplyNextTurn: modeChangesApplyNextTurn,
              modeChangePending,
            }
          : null
      }
      attachmentControl={{
        canAttach,
        attachmentCount,
        onAttachClick,
      }}
      slashControl={
        onSelectSlashCommand
          ? {
              commands: slashCommands,
              onSelectCommand: onSelectSlashCommand,
              disabled: voiceDisabled,
            }
          : null
      }
      thinkingControl={
        supportsThinkingToggle && hasThinkingModeOptions
          ? {
              mode: effectiveThinkingMode,
              modeOptions: thinkingModeOptions,
              level: effectiveThinkingLevel,
              effortOptions: thinkingEffortOptions,
              onSetMode: setSelectedThinkingMode,
              onSetEffort: setSelectedEffortLevel,
              onSetEffortMode: setSelectedThinkingEffortMode,
              onToggleEnabled: toggleThinkingEnabled,
              showThinking,
              onSetShowThinking: setShowThinking ?? (() => {}),
              provider: normalizedThinkingProvider,
            }
          : null
      }
      renderModeControl={
        renderMode
          ? {
              state: renderMode.state,
              title: renderModeTitle,
              onToggle: renderMode.toggleGlobalMode,
            }
          : null
      }
      conversationViewControl={{
        enabled: conversationViewEnabled,
        title: conversationViewTitle,
        onToggle: () => setConversationViewEnabled(!conversationViewEnabled),
      }}
      nudgeControl={
        onToggleHeartbeat
          ? {
              enabled: heartbeatEnabled,
              title: heartbeatTitle,
              onClick: handleHeartbeatClick,
              onContextMenu: handleHeartbeatContextMenu,
              onTouchStart: handleHeartbeatTouchStart,
              onTouchEnd: handleHeartbeatTouchEnd,
              onClearTouch: clearHeartbeatLongPress,
            }
          : null
      }
      speechControl={{
        showMethodSelector: showSpeechMethodSelector,
        methodOptions: speechMethodOptions,
        selectedMethod: selectedSpeechMethod,
        onMethodChange: handleSpeechMethodSelect,
        smartTurnSettings: activeSpeechSmartTurnSettings,
        onSmartTurnSettingsChange: supportsSelectedSpeechSmartTurn
          ? setSpeechSmartTurnSettings
          : undefined,
        smartTurnDisabled: voiceDisabled,
        voiceButton:
          !hideVoiceInput &&
          toolbarVisibility.microphone &&
          voiceButtonRef &&
          onVoiceTranscript &&
          onInterimTranscript
            ? {
                kind: "live",
                ref: voiceButtonRef,
                onTranscript: onVoiceTranscript,
                onInterimTranscript,
                onListeningStart,
                onListeningStop,
                onPendingSpeechChange: handleToolbarPendingSpeechChange,
                onTranscriptionSettled,
                showWaveform: toolbarVisibility.waveform,
                disabled: voiceDisabled,
                speechMethod: selectedSpeechMethod,
                getTranscriptionContext,
                smartTurn: activeSpeechSmartTurnSettings,
              }
            : undefined,
      }}
      speechWaveformActive={
        toolbarVisibility.waveform &&
        speechCaptureActive &&
        selectedSpeechMethod !== DEFAULT_SPEECH_METHOD
      }
      statusControl={{
        showToolbarStatus,
        showLivenessChip,
        livenessDisplay,
        livenessSummary,
        providerRuntimeDisplay,
        nowMs,
        showLastActivityChip,
        showLastActivityPrefix,
        lastActivityMs,
        lastActivityIsPast,
        positionTimestampMs: positionTimestampMs ?? null,
        showPositionTimestamp,
        hasPositionAge,
        hasLastActivityAge,
      }}
      pendingApproval={pendingApproval}
      shortcutsControl={{
        open: shortcutsOpen,
        isearchScope,
        setOpen: setShortcutsOpen,
        settingsOpen: shortcutSettingsOpen,
        setSettingsOpen: setShortcutSettingsOpen,
        hasDualActions,
        enterActionKind: enterActionKind ?? effectivePrimaryActionKind,
        canSwapEnterAction: canSwapDisplayedEnterAction,
        onSwapEnterAction,
        queueShortcutLabel,
        canForkAfterSummary,
      }}
      actionsControl={{
        disabled,
        voiceDisabled,
        contextUsage,
        contextModel: contextRequestedModel ?? thinkingModel,
        contextProvider: thinkingProviderInfo?.name,
        contextWindow: thinkingModelInfo?.contextWindow,
        btw: onBtwClick
          ? {
              onClick: onBtwClick,
              pressed: btwPressed,
              mode: effectiveBtwToolbarMode,
              title: btwTitle,
            }
          : null,
        stop: showStopButton
          ? {
              onStop: onStop!,
              title: stopTitle,
            }
          : null,
        send: showSendButton
          ? {
              onSend,
              onSteer,
              canSend,
              primaryActionKind: effectivePrimaryActionKind,
              primaryActionLabel,
              tooltip: sendTooltip,
              icon: primaryActionIcon,
              speechMessagePrefix,
              primarySpeechMessagePrefix:
                primarySpeechMessagePrefix === undefined
                  ? speechMessagePrefix
                  : primarySpeechMessagePrefix,
              showSteerNowMode,
              steerNowEnabled,
              onToggleSteerNow,
              queue: {
                onQueue,
                onSteer,
                hasDualActions,
                queueTooltip,
              },
              alternate: sendAlternate,
            }
          : null,
        projectQueue:
          supportsProjectQueue && (onProjectQueue || onProjectQueueNewSession)
            ? {
                onProjectQueue,
                onProjectQueueNewSession,
                canSend,
                tooltip: onProjectQueue
                  ? showProjectQueueShortcut
                    ? t("toolbarProjectQueueTooltipWithShortcut")
                    : t("toolbarProjectQueueTooltip")
                  : undefined,
                newSessionTooltip: onProjectQueueNewSession
                  ? t("toolbarProjectQueueNewSessionTooltip")
                  : undefined,
              }
            : null,
      }}
      hidePrimaryDeliveryActions={hidePrimaryDeliveryActions}
    />
  );
}
