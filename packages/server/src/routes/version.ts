import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  APPROVAL_AUDIT_LOG_CAPABILITY,
  BANG_COMMANDS_CAPABILITY,
  BROWSER_SETTINGS_BACKUP_CAPABILITY,
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  DEVICE_BRIDGE_AVAILABLE_CAPABILITY,
  DEVICE_BRIDGE_CAPABILITY,
  DEVICE_BRIDGE_DOWNLOAD_CAPABILITY,
  DEVICE_BRIDGE_UPDATE_CAPABILITY,
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GLOSSARY_TOOLTIPS_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  GIT_STATUS_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
  HOST_AWAKE_CONTROL_CAPABILITY,
  HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  HOST_IDENTITY_CAPABILITY,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
  PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_FORK_TURN_INTENTS_CAPABILITY,
  SECURITY_CLIENT_AUDIT_CAPABILITY,
  TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
  VOICE_INPUT_CAPABILITY,
  type ClientDefaults,
  type SessionSandboxAvailability,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { getSessionSandboxAvailability as getLocalSessionSandboxAvailability } from "../session-sandbox.js";
import type {
  SpeechBackendCapabilities,
  SpeechBackendInfo,
} from "../services/voice/SpeechBackend.js";
import { isNewerSemver } from "../utils/semver.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execAsync = promisify(exec);

/**
 * Get version from git describe (for dev mode)
 * Returns something like "v0.1.7" or "v0.1.7-3-g050bfd2" (3 commits after tag)
 */
export function normalizeGitDescribeVersion(version: string): string | null {
  const trimmed = version.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^v(?=\d)/, "");
}

async function getGitVersion(): Promise<string | null> {
  try {
    const { stdout } = await execAsync(
      "git describe --tags --always --match 'v[0-9]*.[0-9]*.[0-9]*'",
      { encoding: "utf-8" },
    );
    return normalizeGitDescribeVersion(stdout);
  } catch {
    return null;
  }
}

export type InstallSource =
  | "npm-global"
  | "source"
  | "release-package"
  | "unknown";

export interface CurrentVersionInfo {
  version: string;
  installSource: InstallSource;
}

/**
 * Read the current package version and best-effort install source.
 */
async function getCurrentVersionInfo(): Promise<CurrentVersionInfo> {
  try {
    // In production (npm package), package.json is in the parent of dist/
    // In development, it's in packages/server/
    const packageJsonPath = path.resolve(__dirname, "../../package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const version = packageJson.version || "unknown";

    // 0.0.1 is the workspace version - we're in dev mode, use git instead
    if (version === "0.0.1") {
      return {
        version: (await getGitVersion()) || "dev",
        installSource: "source",
      };
    }

    return {
      version,
      installSource: await detectReleaseInstallSource(packageJsonPath),
    };
  } catch {
    return { version: "unknown", installSource: "unknown" };
  }
}

async function detectReleaseInstallSource(
  packageJsonPath: string,
): Promise<InstallSource> {
  const packageRoot = await realpathOrResolve(path.dirname(packageJsonPath));
  const npmGlobalRoot = await getNpmGlobalRoot();
  if (npmGlobalRoot && isPathInside(packageRoot, npmGlobalRoot)) {
    return "npm-global";
  }
  return "release-package";
}

async function getNpmGlobalRoot(): Promise<string | null> {
  try {
    const { stdout } = await execAsync("npm root -g", {
      encoding: "utf-8",
    });
    const npmGlobalRoot = stdout.trim();
    if (!npmGlobalRoot) return null;
    return realpathOrResolve(npmGlobalRoot);
  } catch {
    return null;
  }
}

async function realpathOrResolve(value: string): Promise<string> {
  try {
    return await fs.promises.realpath(value);
  } catch {
    return path.resolve(value);
  }
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    !path.isAbsolute(relative)
  );
}

const UPDATE_SERVER_URL = "https://updates.yepanywhere.com/version";

// Cache for update server check (24 hour TTL for routine app traffic)
let cachedLatestVersion: { version: string; timestamp: number } | null = null;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Fetch the latest version from the update server.
 * Sends current version and install ID for analytics.
 */
async function getLatestVersion(
  currentVersion: string,
  installId?: string,
  options?: { forceRefresh?: boolean },
): Promise<string | null> {
  // Return cached value if fresh
  if (
    !options?.forceRefresh &&
    cachedLatestVersion &&
    Date.now() - cachedLatestVersion.timestamp < CACHE_TTL_MS
  ) {
    return cachedLatestVersion.version;
  }

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (installId) {
      headers["X-CFU-ID"] = installId;
    }

    const response = await fetch(`${UPDATE_SERVER_URL}/${currentVersion}`, {
      signal: controller.signal,
      headers,
    });

    clearTimeout(timeoutId);

    // 204 = no update available (current version is latest)
    if (response.status === 204) {
      cachedLatestVersion = { version: currentVersion, timestamp: Date.now() };
      return currentVersion;
    }

    if (!response.ok) {
      return null;
    }

    const data = (await response.json()) as { version?: string };
    const version = data.version || null;

    if (version) {
      cachedLatestVersion = { version, timestamp: Date.now() };
    }

    return version;
  } catch {
    // Network error, timeout, etc. - fail silently
    return null;
  }
}

export interface VersionInfo {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  /** Best-effort install source for update guidance. Absent on older servers. */
  installSource?: InstallSource;
  /** Session resume protocol version supported by this server. */
  resumeProtocolVersion: number;
  /** Coarse hosted remote UI/server compatibility level. */
  remoteCompatibilityLevel: number;
  /** Feature capabilities supported by this server. Used by clients to show/hide UI. */
  capabilities: string[];
  /** Local host preflight for the optional YA session sandbox backend. */
  sessionSandboxing?: SessionSandboxAvailability;
  /**
   * Speech backend ids this server has validated and is willing to route
   * audio to. Browser-native remains client-side and is not listed here.
   */
  voiceBackends?: string[];
  /** Configured speech backends, including startup validation state. */
  voiceBackendStatuses?: SpeechBackendInfo[];
  /** Capability map keyed by server-routed speech backend id. */
  voiceBackendCapabilities?: Record<string, SpeechBackendCapabilities>;
  /** Device bridge availability and update state. */
  deviceBridgeState?: DeviceBridgeState;
  /** Installed managed bridge binary version when known. */
  deviceBridgeVersion?: string | null;
  /** Latest bridge release version when known. */
  latestDeviceBridgeVersion?: string | null;
  /** Server-learned browser defaults used when local storage is unset. */
  clientDefaults?: ClientDefaults;
  /** Whether this process is the server bundled with the desktop shell. */
  desktopRuntime?: boolean;
}

/** Resume protocol version with mutual nonce challenge + server proof binding. */
export const RESUME_PROTOCOL_VERSION = 3;
/** Coarse hosted remote UI/server compatibility generation. */
export const REMOTE_COMPATIBILITY_LEVEL = 10;

const BASE_CAPABILITIES: string[] = [
  GLOSSARY_TOOLTIPS_CAPABILITY,
  GIT_STATUS_CAPABILITY,
  GIT_STATUS_ENHANCED_CAPABILITY,
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  GIT_STATUS_REMOTE_CHECK_CAPABILITY,
  GIT_STATUS_PULL_CAPABILITY,
  GIT_STATUS_PUSH_CAPABILITY,
  GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY,
  APPROVAL_AUDIT_LOG_CAPABILITY,
  BANG_COMMANDS_CAPABILITY,
  CLAUDE_ADDITIONAL_MODELS_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  HOST_AWAKE_CONTROL_CAPABILITY,
  HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY,
  HOST_IDENTITY_CAPABILITY,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  PROJECT_QUEUE_CAPABILITY,
  PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY,
  PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY,
  PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_FORK_TURN_INTENTS_CAPABILITY,
  TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY,
];

export type DeviceBridgeState =
  | "available"
  | "downloadable"
  | "update-available"
  | "unavailable";

export interface DeviceBridgeStatus {
  state: DeviceBridgeState;
  installedVersion?: string | null;
  latestVersion?: string | null;
}

export interface VersionRouteOptions {
  /** Whether the signed security-client audit routes are mounted. */
  securityClientAuditAvailable?: boolean;
  /** Whether the browser-settings backup storage route is mounted. */
  browserSettingsBackupAvailable?: boolean;
  /** Dynamic device bridge state: available (binary exists), downloadable (ADB found, no binary), unavailable (no ADB). */
  getDeviceBridgeState?: () => DeviceBridgeState;
  /** Detailed device bridge status for version-aware update prompts. */
  getDeviceBridgeStatus?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<DeviceBridgeStatus>;
  /** Whether the user has opted into the device bridge feature. */
  isDeviceBridgeEnabled?: () => boolean;
  /** Unique installation ID for update analytics. */
  installId?: string;
  /** Whether voice input is enabled (default: true). */
  voiceInputEnabled?: boolean;
  /**
   * Returns ids of server-routed speech backends validated at startup.
   * Browser-native is implicit and intentionally not included.
   */
  getEnabledVoiceBackends?: () => string[];
  /** Returns all configured backends, including pending and disabled entries. */
  getVoiceBackendStatuses?: () => SpeechBackendInfo[];
  /** Returns capabilities keyed by validated backend id. */
  getVoiceBackendCapabilities?: () => Record<string, SpeechBackendCapabilities>;
  /** Browser-client defaults persisted by this server. */
  getClientDefaults?: () => ClientDefaults | undefined;
  /** Whether this process is the server bundled with the desktop shell. */
  desktopRuntime?: boolean;
  /** Whether the Linux Codex lifecycle host registered successfully. */
  reloadSafeCodexRuntimeAvailable?: boolean;
  /** Resolved local sandbox preflight used while constructing capabilities. */
  sessionSandboxAvailability?: SessionSandboxAvailability;
  /** Test/service override for the cached host preflight. */
  getSessionSandboxAvailability?: (options?: {
    forceRefresh?: boolean;
  }) => Promise<SessionSandboxAvailability>;
}

export interface ServerCompatibilityInfo {
  appVersion: string;
  installSource: InstallSource;
  resumeProtocolVersion: number;
  remoteCompatibilityLevel: number;
  renderProtocolVersion?: number;
  capabilities: string[];
  clientDefaults?: ClientDefaults;
  desktopRuntime?: boolean;
}

function getCapabilitiesForDeviceBridgeState(
  state: DeviceBridgeState,
  enabled: boolean,
): string[] {
  if (state === "unavailable") {
    return [];
  }

  const capabilities: string[] = [DEVICE_BRIDGE_AVAILABLE_CAPABILITY];
  if (!enabled) {
    return capabilities;
  }

  if (state === "available") {
    capabilities.push(DEVICE_BRIDGE_CAPABILITY);
    return capabilities;
  }

  capabilities.push(DEVICE_BRIDGE_DOWNLOAD_CAPABILITY);
  if (state === "update-available") {
    capabilities.push(DEVICE_BRIDGE_UPDATE_CAPABILITY);
  }
  return capabilities;
}

export function getServerCapabilities(options?: VersionRouteOptions): string[] {
  const capabilities: string[] = [...BASE_CAPABILITIES];
  if (options?.sessionSandboxAvailability?.state === "available") {
    capabilities.push(SESSION_SANDBOXING_CAPABILITY);
  }
  if (options?.browserSettingsBackupAvailable) {
    capabilities.push(BROWSER_SETTINGS_BACKUP_CAPABILITY);
  }
  if (options?.securityClientAuditAvailable) {
    capabilities.push(SECURITY_CLIENT_AUDIT_CAPABILITY);
  }
  if (options?.voiceInputEnabled !== false) {
    capabilities.push(VOICE_INPUT_CAPABILITY);
  }
  if (options?.reloadSafeCodexRuntimeAvailable) {
    capabilities.push(RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY);
  }
  const deviceBridgeState = options?.getDeviceBridgeState?.() ?? "unavailable";
  const enabled = options?.isDeviceBridgeEnabled?.() ?? false;
  capabilities.push(
    ...getCapabilitiesForDeviceBridgeState(deviceBridgeState, enabled),
  );
  return capabilities;
}

export function getEnabledVoiceBackends(
  options?: VersionRouteOptions,
): string[] {
  if (options?.voiceInputEnabled === false) {
    return [];
  }
  return options?.getEnabledVoiceBackends?.() ?? [];
}

export function getVoiceBackendCapabilities(
  options?: VersionRouteOptions,
): Record<string, SpeechBackendCapabilities> {
  if (options?.voiceInputEnabled === false) {
    return {};
  }
  return options?.getVoiceBackendCapabilities?.() ?? {};
}

export function getServerCompatibilityInfo(
  options?: VersionRouteOptions,
): Promise<ServerCompatibilityInfo> {
  const clientDefaults = options?.getClientDefaults?.();
  return Promise.all([
    getCurrentVersionInfo(),
    (
      options?.getSessionSandboxAvailability ??
      getLocalSessionSandboxAvailability
    )(),
  ]).then(([versionInfo, sessionSandboxAvailability]) => ({
    appVersion: versionInfo.version,
    installSource: versionInfo.installSource,
    resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
    remoteCompatibilityLevel: REMOTE_COMPATIBILITY_LEVEL,
    capabilities: getServerCapabilities({
      ...options,
      sessionSandboxAvailability,
    }),
    ...(clientDefaults ? { clientDefaults } : {}),
    ...(options?.desktopRuntime ? { desktopRuntime: true } : {}),
  }));
}

export function createVersionRoutes(options?: VersionRouteOptions): Hono {
  const routes = new Hono();

  routes.get("/", async (c) => {
    const currentVersionInfo = await getCurrentVersionInfo();
    const current = currentVersionInfo.version;
    const fresh =
      c.req.query("fresh") === "1" || c.req.query("fresh") === "true";
    const deviceBridgeStatus = options?.getDeviceBridgeStatus
      ? await options.getDeviceBridgeStatus({ forceRefresh: fresh })
      : { state: options?.getDeviceBridgeState?.() ?? "unavailable" };
    const sessionSandboxAvailability = await (
      options?.getSessionSandboxAvailability ??
      getLocalSessionSandboxAvailability
    )({ forceRefresh: fresh });
    const capabilities = getServerCapabilities({
      ...options,
      getDeviceBridgeState: () => deviceBridgeStatus.state,
      sessionSandboxAvailability,
    });
    const voiceBackends = getEnabledVoiceBackends(options);
    const voiceBackendStatuses = options?.getVoiceBackendStatuses?.() ?? [];
    const voiceBackendCapabilities = getVoiceBackendCapabilities(options);
    const clientDefaults = options?.getClientDefaults?.();

    // For dev versions like "v0.1.7-3-g050bfd2", extract base version "v0.1.7"
    // to compare against the update server.
    const baseVersion = current.split("-")[0] || current;
    const latest = await getLatestVersion(baseVersion, options?.installId, {
      forceRefresh: fresh,
    });
    const updateAvailable = latest ? isNewerSemver(baseVersion, latest) : false;

    const info: VersionInfo = {
      current,
      latest,
      updateAvailable,
      installSource: currentVersionInfo.installSource,
      resumeProtocolVersion: RESUME_PROTOCOL_VERSION,
      remoteCompatibilityLevel: REMOTE_COMPATIBILITY_LEVEL,
      capabilities,
      sessionSandboxing: sessionSandboxAvailability,
      voiceBackends,
      voiceBackendStatuses,
      voiceBackendCapabilities,
      deviceBridgeState: deviceBridgeStatus.state,
      deviceBridgeVersion: deviceBridgeStatus.installedVersion ?? null,
      latestDeviceBridgeVersion: deviceBridgeStatus.latestVersion ?? null,
      ...(clientDefaults ? { clientDefaults } : {}),
      ...(options?.desktopRuntime ? { desktopRuntime: true } : {}),
    };

    return c.json(info);
  });

  return routes;
}
