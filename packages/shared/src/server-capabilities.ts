export type ServerCapabilityKind = "permanent" | "transitional";

export interface ServerCapabilitySource {
  capabilities?: readonly string[];
}

export interface ServerCapabilityPermanentLifecycle {
  kind: "permanent";
  reason: string;
}

export interface ServerCapabilityTransitionalLifecycle {
  kind: "transitional";
  reviewAfter: string;
  removeClientGateWhen: string;
  removeServerAdvertisementWhen?: string;
}

export interface ServerCapabilityDefinition {
  name: string;
  kind: ServerCapabilityKind;
  area:
    | "deviceBridge"
    | "gitStatus"
    | "localAccess"
    | "projectQueue"
    | "providers"
    | "remoteAccess"
    | "settings"
    | "speech";
  description: string;
  introducedIn: string;
  clientFallback: string;
  serverContract?: {
    routes?: readonly string[];
    /**
     * Repository-relative server route modules wholly owned by this
     * capability. `pnpm capabilities:audit` requires every route declared in
     * these modules to appear in `routes`, and rejects stale route entries.
     */
    routeModules?: readonly string[];
    requestFields?: readonly string[];
    responseFields?: readonly string[];
    events?: readonly string[];
  };
  lifecycle:
    | ServerCapabilityPermanentLifecycle
    | ServerCapabilityTransitionalLifecycle;
}

export const SERVER_CAPABILITIES = {
  gitStatus: {
    name: "git-status",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    description:
      "Server supports project source-control status summaries for the Source Control page and sidebar entry.",
    clientFallback: "Hide Source Control entry points.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Source Control availability is a server feature boundary for older servers and environments without the route.",
    },
  },
  gitStatusEnhanced: {
    name: "git-status-enhanced",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    description:
      "Server supports the enhanced Source Control page, including file summaries, branch metadata, and recent commits.",
    clientFallback: "Show the Source Control upgrade/unsupported state.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git",
        "GET /api/projects/:projectId/git/untracked-folder",
        "POST /api/projects/:projectId/git/diff",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The enhanced Source Control UI must stay hidden against older servers with only legacy status support.",
    },
  },
  gitStatusRemoteCheck: {
    name: "git-status-remote-check",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    description:
      "Server supports explicit remote fetch/check for Source Control status.",
    clientFallback: "Hide remote-check controls.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/check-remote"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Remote checking depends on a server-side git operation endpoint and may be unavailable on older servers.",
    },
  },
  gitStatusPull: {
    name: "git-status-pull",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    description: "Server supports Source Control pull actions.",
    clientFallback: "Hide pull controls.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/pull"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Pull is a mutating server-side git operation and must only be offered when the server advertises it.",
    },
  },
  gitStatusPush: {
    name: "git-status-push",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    description: "Server supports Source Control push/publish actions.",
    clientFallback: "Hide push controls.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/git/push"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Push is a mutating server-side git operation and must only be offered when the server advertises it.",
    },
  },
  gitStatusIntegrationOptions: {
    name: "git-status-integration-options",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.6.0",
    description:
      "Server supports read-only Source Control integration-option analysis for diverged branches.",
    clientFallback: "Hide automatic integration-option controls.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/git/integration-options"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Integration-option analysis depends on server-side route behavior older servers may not expose.",
    },
  },
  gitSourceReview: {
    name: "git-source-review",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    description:
      "Server supports the commit/file browser and server-owned source-review workflow.",
    clientFallback:
      "Keep basic Source Control status and individually capability-gated remote actions; explain that browsing and review require a server update.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/commits",
        "GET /api/projects/:projectId/git/commit-search-manifest",
        "POST /api/projects/:projectId/git/commit-search-records",
        "GET /api/projects/:projectId/git/commit/:sha",
        "POST /api/projects/:projectId/git/commit-diff",
        "GET /api/projects/:projectId/git/blame",
        "GET /api/projects/:projectId/git/files",
        "GET /api/projects/:projectId/git/search",
        "GET /api/projects/:projectId/review/comments",
        "POST /api/projects/:projectId/review/comments",
        "PATCH /api/projects/:projectId/review/comments/:commentId",
        "DELETE /api/projects/:projectId/review/comments/:commentId",
        "POST /api/projects/:projectId/review/preview",
        "POST /api/projects/:projectId/review/submit",
      ],
      routeModules: [
        "packages/server/src/routes/git-browse.ts",
        "packages/server/src/routes/review-comments.ts",
      ],
      requestFields: ["gitDiff.againstHead", "gitDiff.origPath"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, while Source Control must retain its released basic status and synchronization path.",
    },
  },
  gitSourceReviewProjections: {
    name: "git-source-review-projections",
    kind: "transitional",
    area: "gitStatus",
    introducedIn: "0.7.1",
    description:
      "Server supports ignore-whitespace rendering and direct selected-revision-to-HEAD comparisons in Source Control.",
    clientFallback:
      "Keep ordinary working-tree and commit review available; make no projection request and explain that the server must be updated or restarted.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git/compare/:sha",
        "POST /api/projects/:projectId/git/compare-diff",
      ],
      routeModules: ["packages/server/src/routes/git-projections.ts"],
      requestFields: [
        "gitDiff.ignoreWhitespace",
        "gitCommitDiff.ignoreWhitespace",
        "gitCompareDiff.baseSha",
        "gitCompareDiff.headSha",
        "gitCompareDiff.ignoreWhitespace",
      ],
      responseFields: [
        "gitRevisionComparison.baseSha",
        "gitRevisionComparison.headSha",
        "gitRevisionComparison.files",
      ],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-28",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the Source Control projection contract.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on git-source-review-projections.",
    },
  },
  approvalAuditLog: {
    name: "approvalAuditLog",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.6.0",
    description:
      "Server supports configuring approval audit-log persistence from Local Access settings.",
    clientFallback:
      "Treat approval audit logging as a legacy read-only enabled setting.",
    serverContract: {
      routes: ["GET /api/settings", "PATCH /api/settings"],
      responseFields: ["settings.approvalAuditLogEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers lack the configurable approval audit-log setting and should not receive writes for it.",
    },
  },
  browserSettingsBackup: {
    name: "browser-settings-backup",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.6.3",
    description:
      "Server stores one explicit backup of portable browser settings for save/load controls.",
    clientFallback: "Hide browser settings save/load controls.",
    serverContract: {
      routes: [
        "GET /api/settings/browser-backup",
        "PUT /api/settings/browser-backup",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients must not offer server-backed browser settings controls to older servers without the storage route.",
    },
  },
  claudeAdditionalModels: {
    name: "claude-additional-models",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.6.3",
    description:
      "Server persists opt-in previous/custom Claude model ids and exposes the maintained optional catalog.",
    clientFallback: "Hide the Additional models provider setting.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/providers",
        "GET /api/processes/:processId/models",
      ],
      responseFields: [
        "settings.claudeAdditionalModels",
        "providers[].additionalModelOptions",
        "providers[].models[].catalogGroup",
      ],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-25",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the additional-model settings/catalog API.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-additional-models.",
    },
  },
  claudeGateway: {
    name: "claude-gateway",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.7.1",
    description:
      "Server can persist a Claude LLM-gateway URL and expose its models as an isolated Claude Gateway provider.",
    clientFallback:
      "Hide Claude Gateway configuration and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings", "GET /api/providers"],
      requestFields: ["settings.claudeGatewayUrl"],
      responseFields: ["settings.claudeGatewayUrl", "providers[].name"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-27",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the Claude Gateway settings/provider contract.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-gateway.",
    },
  },
  bangCommands: {
    name: "bang-commands",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.6.3",
    description:
      "Server supports always-on local `!!` shell commands, completions, and persisted bang-command history; the top-level history view stays behind an explicit default-off setting.",
    clientFallback: "Hide bang-command entry points and composer routing.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/projects/:projectId/sessions/:sessionId/bang-commands",
        "POST /api/projects/:projectId/sessions/:sessionId/bang-commands/:objectId/kill",
        "GET /api/projects/:projectId/sessions/:sessionId/bang-commands/:objectId/output",
        "DELETE /api/projects/:projectId/sessions/:sessionId/bang-commands/:objectId",
        "GET /api/projects/:projectId/bang-completions",
        "GET /api/bang-commands",
      ],
      responseFields: ["settings.clientDefaults.bangCommandsEnabled"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Local command execution is an explicit server security boundary and older servers may not expose the routes or setting.",
    },
  },
  hostIdentity: {
    name: "host-identity",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.6.3",
    description:
      "Server persists an optional visual marker identifying the current YA host.",
    clientFallback: "Hide host identity settings and render no host marker.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      responseFields: ["settings.hostIdentity"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may remain compatible with older servers that cannot persist host identity.",
    },
  },
  hostAwakeControl: {
    name: "host-awake-control",
    kind: "transitional",
    area: "remoteAccess",
    introducedIn: "0.6.3",
    description:
      "Server supports process-lifetime host-awake settings and status discovery.",
    clientFallback: "Hide host-awake settings.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/settings/host-awake/status",
      ],
      responseFields: [
        "settings.hostAwakeMode",
        "settings.hostAwakeBatteryFloorPercent",
      ],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-21",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the host-awake settings/status API.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on host-awake-control.",
    },
  },
  projectQueue: {
    name: "projectQueue",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.5.0",
    description:
      "Server supports durable project-scoped queue creation, listing, mutation, dispatch pause/resume, and promotion.",
    clientFallback: "Hide Project Queue entry points.",
    serverContract: {
      routes: [
        "GET /api/project-queue",
        "POST /api/project-queue/pause",
        "POST /api/project-queue/resume",
        "POST /api/project-queue/:projectId/promote-now",
        "GET /api/projects/:projectId/queue",
        "POST /api/projects/:projectId/queue",
        "PATCH /api/projects/:projectId/queue/:itemId",
        "DELETE /api/projects/:projectId/queue/:itemId",
        "POST /api/projects/:projectId/queue/:itemId/retry",
        "POST /api/projects/:projectId/queue/:itemId/move-to-top",
      ],
      events: ["project-queue-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Project Queue availability remains a server feature boundary for older servers and hosted remote clients.",
    },
  },
  projectQueueNewSessionShortcutSetting: {
    name: "project-queue-new-session-shortcut-setting",
    kind: "permanent",
    area: "projectQueue",
    introducedIn: "0.6.3",
    description:
      "Server accepts and persists the active-composer new-session Project Queue shortcut presence setting.",
    clientFallback:
      "Hide the active-composer new-session shortcut and its Toolbar setting.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      responseFields: [
        "settings.clientDefaults.sessionToolbarPresence.projectQueueNewSessionShortcut",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients must not save the new toolbar presence key to older servers that reject it.",
    },
  },
  voiceInput: {
    name: "voiceInput",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.6.0",
    description:
      "Server permits voice input features and may expose server-routed speech backends.",
    clientFallback:
      "When absent from a capabilities-bearing response, hide or disable voice input controls.",
    serverContract: {
      routes: [
        "POST /api/speech/transcribe",
        "POST /api/speech/prewarm",
        "GET /api/speech/ws",
        "POST /api/speech/xai-client-key",
        "POST /api/speech/xai-client-secret",
      ],
      responseFields: [
        "voiceBackends",
        "voiceBackendStatuses",
        "voiceBackendCapabilities",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Voice input can be disabled by server configuration and older clients preserve fallback behavior when version data is absent.",
    },
  },
  deviceBridgeAvailable: {
    name: "deviceBridge-available",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    description:
      "Server recognizes the device bridge feature and can surface device settings or setup state.",
    clientFallback: "Hide device bridge settings and navigation.",
    serverContract: {
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Device bridge availability varies by server environment and installation state.",
    },
  },
  deviceBridge: {
    name: "deviceBridge",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    description:
      "Server has an installed device bridge runtime and device routes can be used.",
    clientFallback: "Hide live device controls.",
    serverContract: {
      routes: [
        "GET /api/devices",
        "POST /api/devices/:id/start",
        "POST /api/devices/:id/stop",
        "GET /api/devices/:id/screenshot",
      ],
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The installed bridge runtime is environment-dependent and can change without a protocol-version change.",
    },
  },
  deviceBridgeDownload: {
    name: "deviceBridge-download",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    description:
      "Server can download or update managed device bridge runtime dependencies.",
    clientFallback: "Hide device bridge download/update prompts.",
    serverContract: {
      routes: ["POST /api/devices/bridge/download"],
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Download support depends on server environment and is advertised separately from installed runtime availability.",
    },
  },
  deviceBridgeUpdate: {
    name: "deviceBridge-update",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    description:
      "Server reports an available update for managed device bridge runtime dependencies.",
    clientFallback:
      "Show download/setup state without an update-specific prompt.",
    serverContract: {
      routes: ["POST /api/devices/bridge/download"],
      responseFields: ["deviceBridgeState", "latestDeviceBridgeVersion"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Update availability is dynamic state advertised for older clients that branch on capability strings.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;

export type ServerCapabilityKey = keyof typeof SERVER_CAPABILITIES;
export type ServerCapabilityName =
  (typeof SERVER_CAPABILITIES)[ServerCapabilityKey]["name"];

export const PROJECT_QUEUE_CAPABILITY = SERVER_CAPABILITIES.projectQueue.name;
export const PROJECT_QUEUE_NEW_SESSION_SHORTCUT_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.projectQueueNewSessionShortcutSetting.name;

export const GIT_STATUS_CAPABILITY = SERVER_CAPABILITIES.gitStatus.name;
export const GIT_STATUS_ENHANCED_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusEnhanced.name;
export const GIT_STATUS_REMOTE_CHECK_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusRemoteCheck.name;
export const GIT_STATUS_PULL_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusPull.name;
export const GIT_STATUS_PUSH_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusPush.name;
export const GIT_STATUS_INTEGRATION_OPTIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitStatusIntegrationOptions.name;
export const GIT_SOURCE_REVIEW_CAPABILITY =
  SERVER_CAPABILITIES.gitSourceReview.name;
export const GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitSourceReviewProjections.name;

export const APPROVAL_AUDIT_LOG_CAPABILITY =
  SERVER_CAPABILITIES.approvalAuditLog.name;

export const BROWSER_SETTINGS_BACKUP_CAPABILITY =
  SERVER_CAPABILITIES.browserSettingsBackup.name;

export const CLAUDE_ADDITIONAL_MODELS_CAPABILITY =
  SERVER_CAPABILITIES.claudeAdditionalModels.name;

export const CLAUDE_GATEWAY_CAPABILITY = SERVER_CAPABILITIES.claudeGateway.name;

export const BANG_COMMANDS_CAPABILITY = SERVER_CAPABILITIES.bangCommands.name;

export const HOST_IDENTITY_CAPABILITY = SERVER_CAPABILITIES.hostIdentity.name;

export const HOST_AWAKE_CONTROL_CAPABILITY =
  SERVER_CAPABILITIES.hostAwakeControl.name;

export const VOICE_INPUT_CAPABILITY = SERVER_CAPABILITIES.voiceInput.name;

export const DEVICE_BRIDGE_AVAILABLE_CAPABILITY =
  SERVER_CAPABILITIES.deviceBridgeAvailable.name;
export const DEVICE_BRIDGE_CAPABILITY = SERVER_CAPABILITIES.deviceBridge.name;
export const DEVICE_BRIDGE_DOWNLOAD_CAPABILITY =
  SERVER_CAPABILITIES.deviceBridgeDownload.name;
export const DEVICE_BRIDGE_UPDATE_CAPABILITY =
  SERVER_CAPABILITIES.deviceBridgeUpdate.name;

export function serverHasCapability(
  source: ServerCapabilitySource | null | undefined,
  capability: ServerCapabilityDefinition | ServerCapabilityName | string,
): boolean {
  const name = typeof capability === "string" ? capability : capability.name;
  return source?.capabilities?.includes(name) ?? false;
}
