import {
  ALL_PERMISSION_MODES,
  ALL_PROVIDERS,
  type PermissionMode,
  type ProviderName,
  normalizeRecapAfterSeconds,
} from "@yep-anywhere/shared";

export interface InitialSessionStatus {
  owner: "self";
  processId: string;
  permissionMode?: PermissionMode;
  appliedPermissionMode?: PermissionMode;
  modeVersion?: number;
  recapAfterSeconds?: number;
}

export interface SessionNavigationState {
  initialStatus?: InitialSessionStatus;
  initialTitle?: string;
  initialModel?: string;
  initialProvider?: ProviderName;
  /**
   * Bang-history per-entry actions (topics/bang-commands.md § Top-level
   * history view). Consumed once on arrival at the session page.
   */
  /** Prefill the composer draft with this text (e.g. `!!<command>`) and focus. */
  composerPrefill?: string;
  /** Focus the composer without changing its draft. */
  focusComposer?: boolean;
  /** Scroll the transcript to the row with this `data-render-id`. */
  scrollToRenderId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function isProviderName(value: unknown): value is ProviderName {
  return (
    typeof value === "string" &&
    (ALL_PROVIDERS as readonly string[]).includes(value)
  );
}

function isPermissionMode(value: unknown): value is PermissionMode {
  return (
    typeof value === "string" &&
    (ALL_PERMISSION_MODES as readonly string[]).includes(value)
  );
}

function normalizeModeVersion(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

export function normalizeInitialSessionStatus(
  value: unknown,
): InitialSessionStatus | undefined {
  if (!isRecord(value) || typeof value.processId !== "string") {
    return undefined;
  }

  if (value.owner !== "self" && value.state !== "owned") {
    return undefined;
  }

  const modeVersion = normalizeModeVersion(value.modeVersion);
  return {
    owner: "self",
    processId: value.processId,
    ...(isPermissionMode(value.permissionMode)
      ? { permissionMode: value.permissionMode }
      : {}),
    ...(isPermissionMode(value.appliedPermissionMode)
      ? { appliedPermissionMode: value.appliedPermissionMode }
      : {}),
    ...(modeVersion !== undefined ? { modeVersion } : {}),
    ...(typeof value.recapAfterSeconds === "number" &&
    Number.isFinite(value.recapAfterSeconds)
      ? {
          recapAfterSeconds: normalizeRecapAfterSeconds(
            value.recapAfterSeconds,
          ),
        }
      : {}),
  };
}

export function parseSessionNavigationState(
  value: unknown,
): SessionNavigationState {
  if (!isRecord(value)) {
    return {};
  }

  const initialStatus = normalizeInitialSessionStatus(value.initialStatus);
  return {
    ...(initialStatus ? { initialStatus } : {}),
    ...(typeof value.initialTitle === "string"
      ? { initialTitle: value.initialTitle }
      : {}),
    ...(typeof value.initialModel === "string"
      ? { initialModel: value.initialModel }
      : {}),
    ...(isProviderName(value.initialProvider)
      ? { initialProvider: value.initialProvider }
      : {}),
    ...(typeof value.composerPrefill === "string"
      ? { composerPrefill: value.composerPrefill }
      : {}),
    ...(value.focusComposer === true ? { focusComposer: true } : {}),
    ...(typeof value.scrollToRenderId === "string"
      ? { scrollToRenderId: value.scrollToRenderId }
      : {}),
  };
}

export function createSessionNavigationState(
  state: SessionNavigationState,
): SessionNavigationState {
  return {
    ...(state.initialStatus ? { initialStatus: state.initialStatus } : {}),
    ...(state.initialTitle ? { initialTitle: state.initialTitle } : {}),
    ...(state.initialModel ? { initialModel: state.initialModel } : {}),
    ...(state.initialProvider
      ? { initialProvider: state.initialProvider }
      : {}),
    ...(state.composerPrefill
      ? { composerPrefill: state.composerPrefill }
      : {}),
    ...(state.focusComposer ? { focusComposer: true } : {}),
    ...(state.scrollToRenderId
      ? { scrollToRenderId: state.scrollToRenderId }
      : {}),
  };
}
