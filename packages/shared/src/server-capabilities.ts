import { SECURITY_CLIENT_AUDIT_CAPABILITY } from "./security-clients.js";

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
    | "rendering"
    | "remoteAccess"
    | "security"
    | "sessions"
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
  publicShareManagement: {
    name: "public-share-management",
    kind: "permanent",
    area: "remoteAccess",
    introducedIn: "0.7.1",
    description:
      "Server exposes compact authenticated inventory and bearer-link revocation independently from public-share creation readiness.",
    clientFallback:
      "Hide global and direct management entries, preserve the browser context menu, and make no management request.",
    serverContract: {
      routes: [
        "GET /api/public-shares",
        "DELETE /api/public-shares/:shareId",
        "POST /api/public-shares/revoke-all",
      ],
      routeModules: [
        "packages/server/src/routes/public-share-management.ts",
      ],
      responseFields: [
        "publicShares.items",
        "publicShares.nextCursor",
        "publicShares.totalCount",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers that lack compact inventory and one-link revocation routes.",
    },
  },
  glossaryTooltips: {
    name: "glossary-tooltips",
    kind: "permanent",
    area: "rendering",
    introducedIn: "0.7.1",
    description:
      "Server resolves governing project glossaries, returns compiled phrase automata, and streams project glossary-path changes.",
    clientFallback:
      "Hide Glossary hints, make no artifact request or subscription, and render ordinary Markdown.",
    serverContract: {
      routes: ["GET /api/projects/:projectId/glossary-artifact"],
      routeModules: ["packages/server/src/routes/glossary-artifacts.ts"],
      requestFields: ["glossaryArtifact.sourcePath"],
      responseFields: [
        "glossaryArtifact.status",
        "glossaryArtifact.governingPath",
        "glossaryArtifact.sourceVersion",
        "glossaryArtifact.dependencies",
        "glossaryArtifact.artifact",
        "glossaryArtifact.diagnostics",
      ],
      events: ["glossary-paths-snapshot", "glossary-path-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and glossary discovery must remain server-owned.",
    },
  },
  progressiveSessionCatalog: {
    name: "progressive-session-catalog",
    kind: "permanent",
    area: "sessions",
    introducedIn: "0.7.1",
    description:
      "Server reports a session-collection generation and answers a conditional global session read with no-change instead of re-walking every project.",
    clientFallback:
      "Send no known generation, ignore any reported one, and keep the complete-request enumeration.",
    serverContract: {
      // No `routeModules`: this capability adds an optional request field and
      // two response fields to a route that predates it, rather than owning a
      // module. `global-sessions.ts` also serves `GET /api/sessions/stats`,
      // which this capability has nothing to do with.
      routes: ["GET /api/sessions"],
      requestFields: ["knownGeneration"],
      responseFields: ["generation", "unchanged"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "YA is self-hosted with no forced upgrade, so the population of servers without the conditional read never converges and the client's enumeration fallback never becomes removable.",
    },
  },
  projectDirectoryStoragePolicy: {
    name: "project-directory-storage-policy",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    description:
      "Server defaults project-scoped YA state to its data directory and supports an explicit project-local storage opt-in.",
    clientFallback:
      "Show the storage location as unavailable and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.projectDirectoryStorage"],
      responseFields: ["settings.projectDirectoryStorage"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers may write YA-managed state into project directories without an opt-in.",
    },
  },
  idleReapHoursSetting: {
    name: "idle-reap-hours-setting",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    description:
      "Server exposes a live-configurable best-effort grace before unviewed, verified-idle provider processes may be reaped.",
    clientFallback:
      "Hide the idle-reap control and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.idleReapHours"],
      responseFields: ["settings.idleReapHours"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients may outpace installed servers, and older servers do not expose a persisted idle-reap policy.",
    },
  },
  toolResultMediaPreservationPolicy: {
    name: "tool-result-media-preservation-policy",
    kind: "permanent",
    area: "settings",
    introducedIn: "0.7.1",
    description:
      "Server loads tool-result images on demand by default and can preserve new live results when explicitly enabled.",
    clientFallback:
      "Show media preservation as unavailable and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings"],
      requestFields: ["settings.toolResultMediaPreservation"],
      responseFields: ["settings.toolResultMediaPreservation"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older and development servers may use different tool-media storage semantics.",
    },
  },
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
  gitDirtyFileEditor: {
    name: "git-dirty-file-editor",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    description:
      "Server reports the last YA session observed editing each still-dirty Source Control path.",
    clientFallback:
      "Hide dirty-file session links and make no additional request.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/git",
        "GET /api/projects/:projectId/git/untracked-folder",
      ],
      responseFields: ["files[].lastEditor", "lastEditors"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and older status responses do not carry editor attribution.",
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
  gitSourceReviewSubmissions: {
    name: "git-source-review-submissions",
    kind: "permanent",
    area: "gitStatus",
    introducedIn: "0.7.1",
    description:
      "Server supports captured source-review sites, durable submissions, outcomes, and unread review responses.",
    clientFallback:
      "Retain the version-1 source-review comments and submit flow; hide Reviews and make no capture, submission, site, response, or acknowledgement request.",
    serverContract: {
      routes: [
        "GET /api/projects/:projectId/review/submissions",
        "GET /api/projects/:projectId/review/submissions/:submissionId",
        "POST /api/projects/:projectId/review/submissions/:submissionId/acknowledge",
        "POST /api/projects/:projectId/review/submissions/:submissionId/refresh-response",
        "POST /api/projects/:projectId/review/sites/:siteId/follow-ups",
        "POST /api/projects/:projectId/review/sites/:siteId/resolve",
        "GET /api/review/inbox",
      ],
      routeModules: [
        "packages/server/src/routes/review-submissions.ts",
        "packages/server/src/routes/review-inbox.ts",
      ],
      requestFields: [
        "reviewComment.anchor.projection",
        "reviewSubmit.submissionId",
        "reviewSubmit.name",
        "settings.sourceReviewSubmissionsEnabled",
        "settings.sourceReviewResponseTurns",
      ],
      responseFields: [
        "gitDiff.reviewProjections",
        "settings.sourceReviewSubmissionsEnabled",
        "settings.sourceReviewResponseTurns",
      ],
      events: ["review-response-changed"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The hosted client may outpace servers that expose version-1 source review but cannot preserve captures, submissions, sites, or response state.",
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
  securityClientAudit: {
    name: SECURITY_CLIENT_AUDIT_CAPABILITY,
    kind: "permanent",
    area: "security",
    introducedIn: "0.7.1",
    description:
      "Server supports signed security-client continuity, bounded audit history, and revocation.",
    clientFallback:
      "Do not call security-client routes; native clients may still use ordinary SRP but cannot establish registered-device continuity.",
    serverContract: {
      routes: [
        "POST /api/security/clients/register",
        "POST /api/security/clients/:clientId/check-in",
        "GET /api/security/clients",
        "GET /api/security/events",
        "GET /api/security/clients/:clientId",
        "GET /api/security/clients/:clientId/events",
        "PATCH /api/security/clients/:clientId",
        "DELETE /api/security/clients/:clientId",
      ],
      routeModules: ["packages/server/src/routes/security-clients.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Installed servers may permanently predate the registered-client audit surface, and clients must never probe proof-bearing routes without an exact gate.",
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
  claudeGatewayAutostart: {
    name: "claude-gateway-autostart",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.7.1",
    description:
      "Server can persist and run an explicit shell command when a configured loopback Claude Gateway has no TCP listener.",
    clientFallback:
      "Hide the Gateway start-command field and make no unsupported settings write.",
    serverContract: {
      routes: ["GET /api/settings", "PUT /api/settings", "GET /api/providers"],
      requestFields: ["settings.claudeGatewayStartCommand"],
      responseFields: ["settings.claudeGatewayStartCommand"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-28",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the Gateway autostart setting and provider-refresh behavior.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on claude-gateway-autostart.",
    },
  },
  providerSubscriptionUsage: {
    name: "provider-subscription-usage",
    kind: "transitional",
    area: "providers",
    introducedIn: "0.7.1",
    description:
      "Server exposes normalized read-only provider subscription and rate-limit windows.",
    clientFallback:
      "Make no subscription-usage request and hide model usage badges and context usage detail.",
    serverContract: {
      routes: ["GET /api/providers/:name/subscription-usage"],
      responseFields: ["usage"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-10-29",
      removeClientGateWhen:
        "The hosted-client compatibility floor excludes servers older than the subscription-usage route.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on provider-subscription-usage.",
    },
  },
  reloadSafeCodexRuntimeSettings: {
    name: "reload-safe-codex-runtime-settings",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    description:
      "Server persists the default-off Codex reload-safe-session setting and exposes the restart action used to apply it.",
    clientFallback:
      "Hide the setting, omit its field from writes, and retain ordinary restart behavior.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/server/restart",
      ],
      requestFields: ["settings.codexReloadSafeSessions"],
      responseFields: ["settings.codexReloadSafeSessions"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers that do not understand the setting or reload-safe restart contract.",
    },
  },
  reloadSafeCodexRuntime: {
    name: "reload-safe-codex-runtime",
    kind: "permanent",
    area: "providers",
    introducedIn: "0.7.1",
    description:
      "This Linux server is running under a usable lifecycle host that can retain eligible Codex runtimes across a Hono reload.",
    clientFallback:
      "Show the supported setting as unavailable and keep Codex runtimes under ordinary server ownership.",
    serverContract: {
      routes: ["GET /api/version"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Runtime support depends on the current host, launch mode, and successful lifecycle-host registration.",
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
  hostAgentProcessObservability: {
    name: "host-agent-process-observability",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.7.1",
    description:
      "Server can report minimized host metrics for YA-owned and independently launched provider process trees.",
    clientFallback:
      "Keep the existing Agents inventory, hide host metrics and external rows, and make no host-process request.",
    serverContract: {
      routes: [
        "GET /api/host-agent-processes",
        "GET /api/settings",
        "PUT /api/settings",
      ],
      requestFields: ["settings.hostProcessObservabilityEnabled"],
      responseFields: [
        "settings.hostProcessObservabilityEnabled",
        "hostAgentProcesses.enabled",
        "hostAgentProcesses.supported",
        "hostAgentProcesses.sampledAt",
        "hostAgentProcesses.observations",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients can outpace installed servers, and older servers do not expose the minimized host process route or setting.",
    },
  },
  sessionSandboxing: {
    name: "session-sandboxing",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.7.1",
    description:
      "Server currently has a usable local backend for accepting, persisting, enforcing, and reporting the default-off YA session filesystem sandbox selection.",
    clientFallback:
      "Hide session sandbox controls, omit sandbox fields, and preserve unsandboxed session behavior.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "POST /api/projects/:projectId/sessions",
        "POST /api/projects/:projectId/sessions/create",
        "POST /api/projects/:projectId/queue",
        "POST /api/projects/:projectId/sessions/:sessionId/resume",
        "POST /api/projects/:projectId/sessions/:sessionId/reactivate",
        "POST /api/projects/:projectId/sessions/:sessionId/recap",
        "POST /api/projects/:projectId/sessions/:sessionId/restart",
        "POST /api/projects/:projectId/sessions/:sessionId/fork",
        "POST /api/projects/:projectId/sessions/:sessionId/retitle",
        "POST /api/projects/:projectId/sessions/:sessionId/fork-summary",
        "POST /api/sessions",
        "POST /api/sessions/create",
      ],
      requestFields: [
        "settings.newSessionDefaults.sandboxLevel",
        "sessionStart.sandboxLevel",
        "sessionCreate.sandboxLevel",
        "projectQueue.target.sandboxLevel",
        "sessionRestart.sandboxLevel",
      ],
      responseFields: [
        "settings.newSessionDefaults.sandboxLevel",
        "sessionStart.sandboxEnforcement",
        "sessionResume.sandboxEnforcement",
        "sessionReactivate.sandboxEnforcement",
        "sessionRestart.sandboxEnforcement",
        "process.sandboxEnforcement",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers and unsupported hosts cannot preserve and enforce the launch boundary, so clients must never imply or request it without a dynamically advertised usable backend.",
    },
  },
  sessionSandboxingStatus: {
    name: "session-sandboxing-status",
    kind: "permanent",
    area: "localAccess",
    introducedIn: "0.7.1",
    description:
      "Server reports the local session-sandbox backend preflight state independently from launch-time enforcement.",
    clientFallback:
      "Hide session sandbox controls and make no unsupported sandbox requests.",
    serverContract: {
      routes: ["GET /api/version"],
      responseFields: ["version.sessionSandboxing"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Hosted clients need to distinguish protocol-aware but unsupported hosts and intermediate development servers from hosts with a verified usable backend.",
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
  sessionForkTurnIntents: {
    name: "session-fork-turn-intents",
    kind: "transitional",
    area: "sessions",
    introducedIn: "0.7.1",
    description:
      "Server resolves Clone and direct Fork requests at real completed user-turn boundaries.",
    clientFallback:
      "Hide unified Clone and direct Fork actions and make no fork request.",
    serverContract: {
      routes: ["POST /api/projects/:projectId/sessions/:sessionId/fork"],
      requestFields: ["forkKind", "sourceMessageId"],
    },
    lifecycle: {
      kind: "transitional",
      reviewAfter: "2026-09-01",
      removeClientGateWhen:
        "The optional hosted-client support corpus contains no server without server-resolved fork intents and the Maintainer approves removal.",
      removeServerAdvertisementWhen:
        "No maintained client still branches on session-fork-turn-intents.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;

export type ServerCapabilityKey = keyof typeof SERVER_CAPABILITIES;
export type ServerCapabilityName =
  (typeof SERVER_CAPABILITIES)[ServerCapabilityKey]["name"];

export const PROJECT_DIRECTORY_STORAGE_POLICY_CAPABILITY =
  SERVER_CAPABILITIES.projectDirectoryStoragePolicy.name;
export const PUBLIC_SHARE_MANAGEMENT_CAPABILITY =
  SERVER_CAPABILITIES.publicShareManagement.name;
export const IDLE_REAP_HOURS_SETTING_CAPABILITY =
  SERVER_CAPABILITIES.idleReapHoursSetting.name;
export const GLOSSARY_TOOLTIPS_CAPABILITY =
  SERVER_CAPABILITIES.glossaryTooltips.name;
export const TOOL_RESULT_MEDIA_PRESERVATION_POLICY_CAPABILITY =
  SERVER_CAPABILITIES.toolResultMediaPreservationPolicy.name;
export const PROGRESSIVE_SESSION_CATALOG_CAPABILITY =
  SERVER_CAPABILITIES.progressiveSessionCatalog.name;
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
export const GIT_DIRTY_FILE_EDITOR_CAPABILITY =
  SERVER_CAPABILITIES.gitDirtyFileEditor.name;
export const GIT_SOURCE_REVIEW_CAPABILITY =
  SERVER_CAPABILITIES.gitSourceReview.name;
export const GIT_SOURCE_REVIEW_SUBMISSIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitSourceReviewSubmissions.name;
export const GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY =
  SERVER_CAPABILITIES.gitSourceReviewProjections.name;

export const APPROVAL_AUDIT_LOG_CAPABILITY =
  SERVER_CAPABILITIES.approvalAuditLog.name;

export const BROWSER_SETTINGS_BACKUP_CAPABILITY =
  SERVER_CAPABILITIES.browserSettingsBackup.name;

export const CLAUDE_ADDITIONAL_MODELS_CAPABILITY =
  SERVER_CAPABILITIES.claudeAdditionalModels.name;

export const CLAUDE_GATEWAY_CAPABILITY = SERVER_CAPABILITIES.claudeGateway.name;

export const CLAUDE_GATEWAY_AUTOSTART_CAPABILITY =
  SERVER_CAPABILITIES.claudeGatewayAutostart.name;

export const PROVIDER_SUBSCRIPTION_USAGE_CAPABILITY =
  SERVER_CAPABILITIES.providerSubscriptionUsage.name;

export const RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY =
  SERVER_CAPABILITIES.reloadSafeCodexRuntimeSettings.name;

export const RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY =
  SERVER_CAPABILITIES.reloadSafeCodexRuntime.name;

export const BANG_COMMANDS_CAPABILITY = SERVER_CAPABILITIES.bangCommands.name;

export const HOST_IDENTITY_CAPABILITY = SERVER_CAPABILITIES.hostIdentity.name;

export const HOST_AWAKE_CONTROL_CAPABILITY =
  SERVER_CAPABILITIES.hostAwakeControl.name;

export const HOST_AGENT_PROCESS_OBSERVABILITY_CAPABILITY =
  SERVER_CAPABILITIES.hostAgentProcessObservability.name;

export const SESSION_SANDBOXING_CAPABILITY =
  SERVER_CAPABILITIES.sessionSandboxing.name;

export const SESSION_SANDBOXING_STATUS_CAPABILITY =
  SERVER_CAPABILITIES.sessionSandboxingStatus.name;

export const SESSION_FORK_TURN_INTENTS_CAPABILITY =
  SERVER_CAPABILITIES.sessionForkTurnIntents.name;

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
