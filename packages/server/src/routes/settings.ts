/**
 * Server settings API routes
 */

import {
  DEFAULT_PROJECT_QUEUE_QUIET_SECONDS,
  DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES,
  MAX_PROJECT_QUEUE_QUIET_SECONDS,
  PROMPT_CACHE_KEEPALIVE_MODES,
  clampProjectQueueQuietSeconds,
  isHostAwakeBatteryFloorPercent,
  isHostAwakeMode,
  normalizeYaClientBaseUrl,
  normalizeYaClientBaseUrlFromShareViewerUrl,
  parseClaudeAdditionalModelSelections,
} from "@yep-anywhere/shared";
import { Hono } from "hono";
import { type FileAccessSettings, getFileAccessInfo } from "../middleware/file-access.js";
import type { SessionMetadataService } from "../metadata/index.js";
import { testSSHConnection } from "../sdk/remote-spawn.js";
import type { PublicShareService } from "../services/PublicShareService.js";
import type { HostAwakeService } from "../services/host-awake/HostAwakeService.js";
import type {
  CodexUpdatePolicy,
  ServerSettings,
  ServerSettingsService,
} from "../services/ServerSettingsService.js";
import {
  CODEX_UPDATE_POLICIES,
  DEFAULT_SERVER_SETTINGS,
} from "../services/ServerSettingsService.js";
import {
  isValidSshHostAlias,
  normalizeSshHostAlias,
} from "../utils/sshHostAlias.js";

import {
  discoverOpenAiCompatibleModels,
  mergeClientDefaults,
  normalizeOpenAiCompatibleBaseUrl,
  parseAgentContextHints,
  parseCacheMissBilling,
  parseClientDefaults,
  parseFileAccess,
  parseHelperTargets,
  parseHostIdentity,
  parseHostAliasList,
  parseNewSessionDefaults,
  parsePromptCacheKeepalive,
  parseSpeechAudioRetention,
} from "./settings-parsers.js";

export interface SettingsRoutesDeps {
  serverSettingsService: ServerSettingsService;
  /** Server-stored per-session cache-billing evidence log. */
  sessionMetadataService?: SessionMetadataService;
  /** Callback to apply allowedHosts changes at runtime */
  onAllowedHostsChanged?: (value: string | undefined) => void;
  /** Callback to apply fileAccess changes at runtime */
  onFileAccessChanged?: (value: FileAccessSettings | undefined) => void;
  /** Callback to apply remote session persistence changes at runtime */
  onRemoteSessionPersistenceChanged?: (
    enabled: boolean,
  ) => Promise<void> | void;
  /** Callback to apply Ollama URL changes at runtime */
  onOllamaUrlChanged?: (url: string | undefined) => void;
  /** Callback to apply Ollama system prompt changes at runtime */
  onOllamaSystemPromptChanged?: (prompt: string | undefined) => void;
  /** Callback to apply Ollama full system prompt toggle at runtime */
  onOllamaUseFullSystemPromptChanged?: (enabled: boolean) => void;
  /** Callback to apply Grok Build XAI_API_KEY opt-in at runtime */
  onGrokBuildUseXaiApiKeyChanged?: (enabled: boolean) => void;
  /** Public share storage, used to revoke existing shares when disabled */
  publicShareService?: PublicShareService;
  /** Process-global host-awake policy and status owner. */
  hostAwakeService?: HostAwakeService;
}

export function createSettingsRoutes(deps: SettingsRoutesDeps): Hono {
  const app = new Hono();
  const {
    serverSettingsService,
    sessionMetadataService,
    onAllowedHostsChanged,
    onFileAccessChanged,
    onRemoteSessionPersistenceChanged,
    onOllamaUrlChanged,
    onOllamaSystemPromptChanged,
    onOllamaUseFullSystemPromptChanged,
    onGrokBuildUseXaiApiKeyChanged,
    publicShareService,
    hostAwakeService,
  } = deps;

  /**
   * GET /api/settings
   * Get all server settings
   */
  app.get("/", (c) => {
    const settings = serverSettingsService.getSettings();
    return c.json({ settings });
  });

  app.get("/host-awake/status", async (c) => {
    if (!hostAwakeService) {
      return c.json({ error: "Host-awake status is unavailable" }, 404);
    }
    const status = await hostAwakeService.getStatus({
      forceRefresh: c.req.query("refresh") === "1",
    });
    return c.json({ status });
  });

  /**
   * GET /api/settings/cache-miss-billing/events
   * Read the server-stored prompt-cache billing evidence log.
   */
  app.get("/cache-miss-billing/events", (c) => {
    const rawLimit = Number(c.req.query("limit") ?? 200);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), 500)
        : 200;
    return c.json({
      events: sessionMetadataService?.getCacheMissBillingEvents(limit) ?? [],
    });
  });

  /**
   * GET /api/settings/file-access
   * Read-only info for the File access settings UI: whether an env var pins
   * the allow-set, plus the resolved temp/uploads/home prefixes for hints.
   */
  app.get("/file-access", (c) => {
    return c.json(getFileAccessInfo());
  });

  /**
   * PUT /api/settings
   * Update server settings
   */
  app.put("/", async (c) => {
    const body = await c.req.json<Partial<ServerSettings>>();

    const updates: Partial<ServerSettings> = {};

    // Handle boolean settings
    if (typeof body.serviceWorkerEnabled === "boolean") {
      updates.serviceWorkerEnabled = body.serviceWorkerEnabled;
    }
    if (typeof body.persistRemoteSessionsToDisk === "boolean") {
      updates.persistRemoteSessionsToDisk = body.persistRemoteSessionsToDisk;
    }
    if (typeof body.clientLogCollectionRequested === "boolean") {
      updates.clientLogCollectionRequested = body.clientLogCollectionRequested;
    }
    if (typeof body.approvalAuditLogEnabled === "boolean") {
      updates.approvalAuditLogEnabled = body.approvalAuditLogEnabled;
    }
    if (typeof body.publicSharesEnabled === "boolean") {
      updates.publicSharesEnabled = body.publicSharesEnabled;
    }
    if (typeof body.workstreamsEnabled === "boolean") {
      updates.workstreamsEnabled = body.workstreamsEnabled;
    }
    if (typeof body.composeAnchorsEnabled === "boolean") {
      updates.composeAnchorsEnabled = body.composeAnchorsEnabled;
    }
    if ("hostAwakeMode" in body) {
      if (!isHostAwakeMode(body.hostAwakeMode)) {
        return c.json(
          {
            error:
              "hostAwakeMode must be one of: off, idle, idle-and-closed-lid-on-external-power",
          },
          400,
        );
      }
      updates.hostAwakeMode = body.hostAwakeMode;
    }
    if ("hostAwakeBatteryFloorPercent" in body) {
      if (!isHostAwakeBatteryFloorPercent(body.hostAwakeBatteryFloorPercent)) {
        return c.json(
          {
            error:
              "hostAwakeBatteryFloorPercent must be a whole number from 1 through 100",
          },
          400,
        );
      }
      updates.hostAwakeBatteryFloorPercent =
        body.hostAwakeBatteryFloorPercent;
    }
    if ("deferredJoinWindowSeconds" in body) {
      if (
        body.deferredJoinWindowSeconds === undefined ||
        body.deferredJoinWindowSeconds === null
      ) {
        updates.deferredJoinWindowSeconds = undefined;
      } else if (
        typeof body.deferredJoinWindowSeconds === "number" &&
        Number.isFinite(body.deferredJoinWindowSeconds) &&
        body.deferredJoinWindowSeconds >= 0
      ) {
        updates.deferredJoinWindowSeconds = body.deferredJoinWindowSeconds;
      } else {
        return c.json(
          {
            error:
              "deferredJoinWindowSeconds must be a non-negative number of seconds (0 = never join)",
          },
          400,
        );
      }
    }
    if ("projectQueueQuietSeconds" in body) {
      if (
        body.projectQueueQuietSeconds === undefined ||
        body.projectQueueQuietSeconds === null
      ) {
        updates.projectQueueQuietSeconds = DEFAULT_PROJECT_QUEUE_QUIET_SECONDS;
      } else if (
        typeof body.projectQueueQuietSeconds === "number" &&
        Number.isFinite(body.projectQueueQuietSeconds) &&
        body.projectQueueQuietSeconds >= 0 &&
        body.projectQueueQuietSeconds <= MAX_PROJECT_QUEUE_QUIET_SECONDS
      ) {
        updates.projectQueueQuietSeconds =
          clampProjectQueueQuietSeconds(body.projectQueueQuietSeconds) ??
          DEFAULT_PROJECT_QUEUE_QUIET_SECONDS;
      } else {
        return c.json(
          {
            error: `projectQueueQuietSeconds must be a number of seconds from 0 to ${MAX_PROJECT_QUEUE_QUIET_SECONDS}`,
          },
          400,
        );
      }
    }

    if ("yaClientBaseUrl" in body) {
      if (
        body.yaClientBaseUrl === undefined ||
        body.yaClientBaseUrl === null ||
        body.yaClientBaseUrl === ""
      ) {
        updates.yaClientBaseUrl = undefined;
        updates.publicShareViewerBaseUrl = undefined;
      } else if (typeof body.yaClientBaseUrl === "string") {
        try {
          updates.yaClientBaseUrl = normalizeYaClientBaseUrl(
            body.yaClientBaseUrl,
          );
          updates.publicShareViewerBaseUrl = undefined;
        } catch (error) {
          return c.json(
            {
              error: error instanceof Error ? error.message : "Invalid YA URL",
            },
            400,
          );
        }
      } else {
        return c.json({ error: "yaClientBaseUrl must be a string URL" }, 400);
      }
    } else if ("publicShareViewerBaseUrl" in body) {
      if (
        body.publicShareViewerBaseUrl === undefined ||
        body.publicShareViewerBaseUrl === null ||
        body.publicShareViewerBaseUrl === ""
      ) {
        updates.yaClientBaseUrl = undefined;
        updates.publicShareViewerBaseUrl = undefined;
      } else if (typeof body.publicShareViewerBaseUrl === "string") {
        try {
          updates.yaClientBaseUrl = normalizeYaClientBaseUrlFromShareViewerUrl(
            body.publicShareViewerBaseUrl,
          );
          updates.publicShareViewerBaseUrl = undefined;
        } catch (error) {
          return c.json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Invalid public share viewer URL",
            },
            400,
          );
        }
      } else {
        return c.json(
          { error: "publicShareViewerBaseUrl must be a string URL" },
          400,
        );
      }
    }

    if ("hostIdentity" in body) {
      const parsedHostIdentity = parseHostIdentity(body.hostIdentity);
      if (parsedHostIdentity === null) {
        return c.json(
          { error: "hostIdentity.icon must contain exactly one marker" },
          400,
        );
      }
      updates.hostIdentity = parsedHostIdentity;
    }

    // Handle remoteExecutors array
    if (Array.isArray(body.remoteExecutors)) {
      const { hosts, invalidHost } = parseHostAliasList(body.remoteExecutors);
      if (invalidHost) {
        return c.json(
          { error: `Invalid remote executor host alias: ${invalidHost}` },
          400,
        );
      }
      updates.remoteExecutors = hosts;
    }

    // Handle chromeOsHosts array
    if (Array.isArray(body.chromeOsHosts)) {
      const { hosts, invalidHost } = parseHostAliasList(body.chromeOsHosts);
      if (invalidHost) {
        return c.json(
          { error: `Invalid ChromeOS host alias: ${invalidHost}` },
          400,
        );
      }
      updates.chromeOsHosts = hosts;
    }

    // Handle allowedHosts string ("*", comma-separated hostnames, or undefined to clear)
    if ("allowedHosts" in body) {
      if (
        body.allowedHosts === undefined ||
        body.allowedHosts === null ||
        body.allowedHosts === ""
      ) {
        updates.allowedHosts = undefined;
      } else if (typeof body.allowedHosts === "string") {
        updates.allowedHosts = body.allowedHosts;
      }
    }

    // Handle fileAccess object (checkbox model; undefined/null/"" = secure defaults)
    if ("fileAccess" in body) {
      const parsed = parseFileAccess(body.fileAccess);
      if (parsed === null) {
        return c.json({ error: "Invalid fileAccess setting" }, 400);
      }
      updates.fileAccess = parsed;
    }

    // Handle globalInstructions string (free-form text, or undefined/null/"" to clear)
    if ("globalInstructions" in body) {
      if (
        body.globalInstructions === undefined ||
        body.globalInstructions === null ||
        body.globalInstructions === ""
      ) {
        updates.globalInstructions = undefined;
      } else if (typeof body.globalInstructions === "string") {
        updates.globalInstructions = body.globalInstructions.slice(0, 10000);
      }
    }

    if ("agentContextHints" in body) {
      const parsedHints = parseAgentContextHints(
        body.agentContextHints,
        serverSettingsService.getSetting("agentContextHints"),
      );
      if (parsedHints === null) {
        return c.json({ error: "Invalid agentContextHints setting" }, 400);
      }
      updates.agentContextHints = parsedHints;
    }

    if ("heartbeatTurnsAfterMinutes" in body) {
      if (
        body.heartbeatTurnsAfterMinutes === undefined ||
        body.heartbeatTurnsAfterMinutes === null
      ) {
        updates.heartbeatTurnsAfterMinutes =
          DEFAULT_SERVER_SETTINGS.heartbeatTurnsAfterMinutes;
      } else if (
        typeof body.heartbeatTurnsAfterMinutes === "number" &&
        Number.isInteger(body.heartbeatTurnsAfterMinutes) &&
        body.heartbeatTurnsAfterMinutes >= 1 &&
        body.heartbeatTurnsAfterMinutes <= 1440
      ) {
        updates.heartbeatTurnsAfterMinutes = body.heartbeatTurnsAfterMinutes;
      } else {
        return c.json(
          {
            error:
              "heartbeatTurnsAfterMinutes must be an integer between 1 and 1440",
          },
          400,
        );
      }
    }

    if ("heartbeatTurnText" in body) {
      if (
        body.heartbeatTurnText === undefined ||
        body.heartbeatTurnText === null ||
        body.heartbeatTurnText === ""
      ) {
        updates.heartbeatTurnText = DEFAULT_SERVER_SETTINGS.heartbeatTurnText;
      } else if (typeof body.heartbeatTurnText === "string") {
        updates.heartbeatTurnText = body.heartbeatTurnText.slice(0, 200);
      }
    }

    // Handle ollamaUrl string (URL, or undefined/null/"" to clear)
    if ("ollamaUrl" in body) {
      if (
        body.ollamaUrl === undefined ||
        body.ollamaUrl === null ||
        body.ollamaUrl === ""
      ) {
        updates.ollamaUrl = undefined;
      } else if (typeof body.ollamaUrl === "string") {
        updates.ollamaUrl = body.ollamaUrl;
      }
    }

    // Handle ollamaSystemPrompt string (free-form text, or undefined/null/"" to clear)
    if ("ollamaSystemPrompt" in body) {
      if (
        body.ollamaSystemPrompt === undefined ||
        body.ollamaSystemPrompt === null ||
        body.ollamaSystemPrompt === ""
      ) {
        updates.ollamaSystemPrompt = undefined;
      } else if (typeof body.ollamaSystemPrompt === "string") {
        updates.ollamaSystemPrompt = body.ollamaSystemPrompt.slice(0, 10000);
      }
    }

    // Handle ollamaUseFullSystemPrompt boolean
    if (typeof body.ollamaUseFullSystemPrompt === "boolean") {
      updates.ollamaUseFullSystemPrompt = body.ollamaUseFullSystemPrompt;
    }

    if (typeof body.grokBuildUseXaiApiKey === "boolean") {
      updates.grokBuildUseXaiApiKey = body.grokBuildUseXaiApiKey;
    }

    if ("claudeAdditionalModels" in body) {
      const parsedSelections = parseClaudeAdditionalModelSelections(
        body.claudeAdditionalModels,
      );
      if (parsedSelections === null) {
        return c.json(
          { error: "Invalid claudeAdditionalModels setting" },
          400,
        );
      }
      updates.claudeAdditionalModels = parsedSelections;
    }

    // Handle deviceBridgeEnabled boolean
    if (typeof body.deviceBridgeEnabled === "boolean") {
      updates.deviceBridgeEnabled = body.deviceBridgeEnabled;
    }

    if ("newSessionDefaults" in body) {
      const parsedDefaults = parseNewSessionDefaults(body.newSessionDefaults);
      if (parsedDefaults === null) {
        return c.json({ error: "Invalid newSessionDefaults setting" }, 400);
      }
      updates.newSessionDefaults = parsedDefaults;
    }

    if ("clientDefaults" in body) {
      const parsedDefaults = parseClientDefaults(body.clientDefaults);
      if (parsedDefaults === null) {
        return c.json({ error: "Invalid clientDefaults setting" }, 400);
      }
      updates.clientDefaults = mergeClientDefaults(
        serverSettingsService.getSetting("clientDefaults"),
        parsedDefaults,
      );
    }

    if ("speechAudioRetention" in body) {
      const parsedRetention = parseSpeechAudioRetention(
        body.speechAudioRetention,
      );
      if (parsedRetention === null) {
        return c.json({ error: "Invalid speechAudioRetention setting" }, 400);
      }
      updates.speechAudioRetention = parsedRetention;
    }

    if ("helperTargets" in body) {
      const parsedTargets = parseHelperTargets(body.helperTargets);
      if (parsedTargets === null) {
        return c.json({ error: "Invalid helperTargets setting" }, 400);
      }
      updates.helperTargets = parsedTargets;
    }

    if ("promptCacheKeepalive" in body) {
      const parsedKeepalive = parsePromptCacheKeepalive(
        body.promptCacheKeepalive,
      );
      if (parsedKeepalive === null) {
        return c.json(
          {
            error: `promptCacheKeepalive must configure provider modes (${PROMPT_CACHE_KEEPALIVE_MODES.join(
              ", ",
            )}) and integer inactivityMinutes between 1 and 1440 (default ${DEFAULT_PROMPT_CACHE_KEEPALIVE_INACTIVITY_MINUTES})`,
          },
          400,
        );
      }
      updates.promptCacheKeepalive = parsedKeepalive;
    }

    if ("cacheMissBilling" in body) {
      const parsedCacheMissBilling = parseCacheMissBilling(
        body.cacheMissBilling,
      );
      if (parsedCacheMissBilling === null) {
        return c.json(
          {
            error:
              "cacheMissBilling must use booleans for enabled/showToasts, freshness windows 1-1440, and minimumInputTokens 1-5000000",
          },
          400,
        );
      }
      updates.cacheMissBilling = parsedCacheMissBilling;
    }

    if (typeof body.lifecycleWebhooksEnabled === "boolean") {
      updates.lifecycleWebhooksEnabled = body.lifecycleWebhooksEnabled;
    }
    if (typeof body.lifecycleWebhookDryRun === "boolean") {
      updates.lifecycleWebhookDryRun = body.lifecycleWebhookDryRun;
    }
    if ("lifecycleWebhookUrl" in body) {
      if (
        body.lifecycleWebhookUrl === undefined ||
        body.lifecycleWebhookUrl === null ||
        body.lifecycleWebhookUrl === ""
      ) {
        updates.lifecycleWebhookUrl = undefined;
      } else if (typeof body.lifecycleWebhookUrl === "string") {
        updates.lifecycleWebhookUrl = body.lifecycleWebhookUrl.slice(0, 2000);
      }
    }
    if ("lifecycleWebhookToken" in body) {
      if (
        body.lifecycleWebhookToken === undefined ||
        body.lifecycleWebhookToken === null ||
        body.lifecycleWebhookToken === ""
      ) {
        updates.lifecycleWebhookToken = undefined;
      } else if (typeof body.lifecycleWebhookToken === "string") {
        updates.lifecycleWebhookToken = body.lifecycleWebhookToken.slice(
          0,
          5000,
        );
      }
    }

    if ("codexUpdatePolicy" in body) {
      if (
        body.codexUpdatePolicy === undefined ||
        body.codexUpdatePolicy === null
      ) {
        updates.codexUpdatePolicy = DEFAULT_SERVER_SETTINGS.codexUpdatePolicy;
      } else if (
        typeof body.codexUpdatePolicy === "string" &&
        CODEX_UPDATE_POLICIES.includes(
          body.codexUpdatePolicy as CodexUpdatePolicy,
        )
      ) {
        updates.codexUpdatePolicy = body.codexUpdatePolicy as CodexUpdatePolicy;
      } else {
        return c.json(
          { error: "codexUpdatePolicy must be one of: auto, notify, off" },
          400,
        );
      }
    }

    if (Object.keys(updates).length === 0) {
      return c.json({ error: "At least one valid setting is required" }, 400);
    }

    const currentSettings = serverSettingsService.getSettings();
    const nextHostAwakeMode =
      updates.hostAwakeMode ?? currentSettings.hostAwakeMode;
    const hasHostAwakeUpdate =
      "hostAwakeMode" in updates ||
      "hostAwakeBatteryFloorPercent" in updates;
    if (hasHostAwakeUpdate && !hostAwakeService) {
      return c.json({ error: "Host-awake control is unavailable" }, 503);
    }
    if (
      hostAwakeService &&
      updates.hostAwakeMode &&
      updates.hostAwakeMode !== "off" &&
      updates.hostAwakeMode !== currentSettings.hostAwakeMode
    ) {
      const check = await hostAwakeService.checkSupport(updates.hostAwakeMode);
      if (!check.ok) {
        return c.json(
          {
            error:
              check.status.reason ??
              "The requested host-awake mode is unavailable",
            status: check.status,
          },
          409,
        );
      }
    }

    const settings = await serverSettingsService.updateSettings(updates);
    const hostAwakeStatus =
      hasHostAwakeUpdate && hostAwakeService
        ? await hostAwakeService.apply(
            nextHostAwakeMode,
            settings.hostAwakeBatteryFloorPercent,
          )
        : undefined;

    // Apply allowedHosts change to middleware at runtime
    if ("allowedHosts" in updates && onAllowedHostsChanged) {
      onAllowedHostsChanged(settings.allowedHosts);
    }
    if ("fileAccess" in updates && onFileAccessChanged) {
      onFileAccessChanged(settings.fileAccess);
    }
    if (
      "persistRemoteSessionsToDisk" in updates &&
      onRemoteSessionPersistenceChanged
    ) {
      await onRemoteSessionPersistenceChanged(
        settings.persistRemoteSessionsToDisk,
      );
    }
    if ("ollamaUrl" in updates && onOllamaUrlChanged) {
      onOllamaUrlChanged(settings.ollamaUrl);
    }
    if ("ollamaSystemPrompt" in updates && onOllamaSystemPromptChanged) {
      onOllamaSystemPromptChanged(settings.ollamaSystemPrompt);
    }
    if (
      "ollamaUseFullSystemPrompt" in updates &&
      onOllamaUseFullSystemPromptChanged
    ) {
      onOllamaUseFullSystemPromptChanged(
        settings.ollamaUseFullSystemPrompt ?? false,
      );
    }
    if ("grokBuildUseXaiApiKey" in updates && onGrokBuildUseXaiApiKeyChanged) {
      onGrokBuildUseXaiApiKeyChanged(settings.grokBuildUseXaiApiKey ?? false);
    }
    if (updates.publicSharesEnabled === false && publicShareService) {
      await publicShareService.revokeAllShares();
    }

    return c.json({
      settings,
      ...(hostAwakeStatus ? { hostAwakeStatus } : {}),
    });
  });

  /**
   * GET /api/settings/remote-executors
   * Get list of configured remote executors
   */
  app.get("/remote-executors", (c) => {
    const settings = serverSettingsService.getSettings();
    return c.json({ executors: settings.remoteExecutors ?? [] });
  });

  /**
   * POST /api/settings/helper-targets/models
   * Discover model ids exposed by an OpenAI-compatible helper endpoint.
   */
  app.post("/helper-targets/models", async (c) => {
    const body = await c.req.json<{ baseUrl?: unknown }>();
    const baseUrl = normalizeOpenAiCompatibleBaseUrl(body.baseUrl);
    if (!baseUrl) {
      return c.json({ error: "baseUrl must be an http(s) URL" }, 400);
    }

    const models = await discoverOpenAiCompatibleModels(baseUrl);
    if (!models) {
      return c.json({ error: "Failed to load helper target models" }, 502);
    }

    return c.json({ baseUrl, models });
  });

  /**
   * PUT /api/settings/remote-executors
   * Update list of remote executors
   */
  app.put("/remote-executors", async (c) => {
    const body = await c.req.json<{ executors: string[] }>();

    if (!Array.isArray(body.executors)) {
      return c.json({ error: "executors must be an array" }, 400);
    }

    const { hosts: validExecutors, invalidHost } = parseHostAliasList(
      body.executors,
    );
    if (invalidHost) {
      return c.json(
        { error: `Invalid remote executor host alias: ${invalidHost}` },
        400,
      );
    }

    await serverSettingsService.updateSettings({
      remoteExecutors: validExecutors,
    });

    return c.json({ executors: validExecutors });
  });

  /**
   * POST /api/settings/remote-executors/:host/test
   * Test SSH connection to a remote executor
   */
  app.post("/remote-executors/:host/test", async (c) => {
    const host = normalizeSshHostAlias(c.req.param("host"));

    if (!host) {
      return c.json({ error: "host is required" }, 400);
    }
    if (!isValidSshHostAlias(host)) {
      return c.json({ error: "host must be a valid SSH host alias" }, 400);
    }

    const result = await testSSHConnection(host);
    return c.json(result);
  });

  return app;
}
