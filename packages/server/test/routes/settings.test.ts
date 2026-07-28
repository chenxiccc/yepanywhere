import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PROJECT_QUEUE_QUIET_SECONDS } from "@yep-anywhere/shared";
import { createSettingsRoutes } from "../../src/routes/settings.js";
import type { PublicShareService } from "../../src/services/PublicShareService.js";
import type { HostAwakeService } from "../../src/services/host-awake/HostAwakeService.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../../src/services/ServerSettingsService.js";
import {
  DEFAULT_SERVER_SETTINGS,
  MAX_CLAUDE_GATEWAY_START_COMMAND_LENGTH,
} from "../../src/services/ServerSettingsService.js";

describe("Settings Routes", () => {
  let settings: ServerSettings;
  let mockServerSettingsService: ServerSettingsService;

  beforeEach(() => {
    settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      clientLogCollectionRequested: false,
      approvalAuditLogEnabled: false,
      speechAudioRetention: DEFAULT_SERVER_SETTINGS.speechAudioRetention,
      publicSharesEnabled: false,
      workstreamsEnabled: false,
      hostAwakeMode: "off",
      hostAwakeBatteryFloorPercent: 10,
    };

    mockServerSettingsService = {
      getSettings: vi.fn(() => settings),
      getSetting: vi.fn(
        <K extends keyof ServerSettings>(key: K): ServerSettings[K] =>
          settings[key],
      ),
      updateSettings: vi.fn(async (updates: Partial<ServerSettings>) => {
        settings = { ...settings, ...updates };
        return settings;
      }),
    } as unknown as ServerSettingsService;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("PUT /remote-executors", () => {
    it("rejects invalid host aliases", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executors: ["devbox", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid remote executor host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts and normalizes valid aliases", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/remote-executors", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          executors: ["  devbox  ", "gpu-server", "", "  "],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.executors).toEqual(["devbox", "gpu-server"]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        remoteExecutors: ["devbox", "gpu-server"],
      });
    });
  });

  describe("PUT /", () => {
    it.each([
      [{ hostAwakeMode: "always" }, "hostAwakeMode"],
      [{ hostAwakeBatteryFloorPercent: 10.5 }, "hostAwakeBatteryFloorPercent"],
      [{ hostAwakeBatteryFloorPercent: 0 }, "hostAwakeBatteryFloorPercent"],
    ])("rejects invalid host-awake settings %j", async (body, errorField) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        hostAwakeService: {} as HostAwakeService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      expect(response.status).toBe(400);
      expect((await response.json()).error).toContain(errorField);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("does not persist an unsupported host-awake enable request", async () => {
      const status = {
        requestedMode: "off" as const,
        state: "unsupported" as const,
        platform: "linux",
        support: {
          idleSleepPrevention: false,
          batteryFloor: false,
          closedLidOnExternalPower: false,
        },
        hasInternalBattery: "unknown" as const,
        batteryFloorPercent: 10,
        reason: "Host-awake control is unavailable on this server",
      };
      const hostAwakeService = {
        checkSupport: vi.fn(async () => ({ ok: false, status })),
      } as unknown as HostAwakeService;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        hostAwakeService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostAwakeMode: "idle" }),
      });

      expect(response.status).toBe(409);
      expect((await response.json()).status).toEqual(status);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("persists and applies a supported host-awake request live", async () => {
      const activeStatus = {
        requestedMode: "idle" as const,
        state: "active" as const,
        platform: "darwin",
        support: {
          idleSleepPrevention: true,
          batteryFloor: true,
          closedLidOnExternalPower: false,
        },
        hasInternalBattery: true,
        powerSource: "external" as const,
        batteryPercent: 80,
        powerObservedAt: 123,
        batteryFloorPercent: 15,
      };
      const hostAwakeService = {
        checkSupport: vi.fn(async () => ({
          ok: true,
          status: { ...activeStatus, requestedMode: "off", state: "disabled" },
        })),
        apply: vi.fn(async () => activeStatus),
      } as unknown as HostAwakeService;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        hostAwakeService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          hostAwakeMode: "idle",
          hostAwakeBatteryFloorPercent: 15,
        }),
      });

      expect(response.status).toBe(200);
      expect(hostAwakeService.apply).toHaveBeenCalledWith("idle", 15);
      expect((await response.json()).hostAwakeStatus).toEqual(activeStatus);
    });

    it("accepts and normalizes a host identity marker", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostIdentity: { icon: " ❤️ " } }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        hostIdentity: { icon: "❤️" },
      });
    });

    it("clears a host identity marker", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostIdentity: null }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        hostIdentity: undefined,
      });
    });

    it("rejects invalid host identity markers", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hostIdentity: { icon: "💻❤️" } }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts clearing globalInstructions with null", async () => {
      settings = {
        ...settings,
        globalInstructions: "Existing instructions",
      };

      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          globalInstructions: null,
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.globalInstructions).toBeUndefined();
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        globalInstructions: undefined,
      });
    });

    it("accepts agent context hint settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentContextHints: { latexMathRendering: true },
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.agentContextHints).toEqual({
        latexMathRendering: true,
      });
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        agentContextHints: { latexMathRendering: true },
      });
    });

    it("rejects invalid agent context hint settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentContextHints: { latexMathRendering: "yes" },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid agentContextHints setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects invalid aliases in remoteExecutors setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          remoteExecutors: ["devbox", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid remote executor host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts and normalizes valid aliases in chromeOsHosts setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeOsHosts: ["  chromeroot  ", "lab-book", "", " "],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.chromeOsHosts).toEqual(["chromeroot", "lab-book"]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        chromeOsHosts: ["chromeroot", "lab-book"],
      });
    });

    it("rejects invalid aliases in chromeOsHosts setting", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chromeOsHosts: ["chromeroot", "-oProxyCommand=touch_/tmp/pwned"],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("Invalid ChromeOS host alias");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts lifecycle webhook settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          lifecycleWebhooksEnabled: true,
          lifecycleWebhookUrl: "https://example.com/hook",
          lifecycleWebhookToken: "secret",
          lifecycleWebhookDryRun: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        lifecycleWebhooksEnabled: true,
        lifecycleWebhookUrl: "https://example.com/hook",
        lifecycleWebhookToken: "secret",
        lifecycleWebhookDryRun: false,
      });
    });

    it("accepts server-requested client log collection", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientLogCollectionRequested: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientLogCollectionRequested: true,
      });
    });

    it("accepts approval audit log settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approvalAuditLogEnabled: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        approvalAuditLogEnabled: true,
      });
    });

    it("accepts the experimental workstreams gate", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workstreamsEnabled: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        workstreamsEnabled: true,
      });
    });

    it("accepts Project Queue quiet-window settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectQueueQuietSeconds: 45,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        projectQueueQuietSeconds: 45,
      });
    });

    it("rejects out-of-range Project Queue quiet-window settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectQueueQuietSeconds: MAX_PROJECT_QUEUE_QUIET_SECONDS + 1,
        }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts Grok Build XAI_API_KEY opt-in setting", async () => {
      const onGrokBuildUseXaiApiKeyChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onGrokBuildUseXaiApiKeyChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grokBuildUseXaiApiKey: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        grokBuildUseXaiApiKey: true,
      });
      expect(onGrokBuildUseXaiApiKeyChanged).toHaveBeenCalledWith(true);
    });

    it("normalizes and applies a Claude gateway URL live", async () => {
      const onClaudeGatewaySettingsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onClaudeGatewaySettingsChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeGatewayUrl: "  http://localhost:4141/  ",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeGatewayUrl: "http://localhost:4141",
      });
      expect(onClaudeGatewaySettingsChanged).toHaveBeenCalledWith({
        url: "http://localhost:4141",
        startCommand: undefined,
      });
    });

    it("persists and applies a Claude gateway start command live", async () => {
      settings = {
        ...settings,
        claudeGatewayUrl: "http://localhost:4141",
      };
      const onClaudeGatewaySettingsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onClaudeGatewaySettingsChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeGatewayStartCommand: "  HOST=localhost gateway start  ",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeGatewayStartCommand: "HOST=localhost gateway start",
      });
      expect(onClaudeGatewaySettingsChanged).toHaveBeenCalledWith({
        url: "http://localhost:4141",
        startCommand: "HOST=localhost gateway start",
      });
    });

    it.each([
      ["non-string", 42],
      [
        "too long",
        `gateway start ${"x".repeat(
          MAX_CLAUDE_GATEWAY_START_COMMAND_LENGTH,
        )}`,
      ],
      ["NUL byte", "gateway\u0000start"],
    ])("rejects a %s Claude gateway start command", async (_case, command) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewayStartCommand: command }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it.each([
      "ftp://localhost:4141",
      "http://user:secret@localhost:4141",
      "http://localhost:4141?token=secret",
      "http://localhost:4141#gateway",
      "localhost:4141",
    ])("rejects unsafe Claude gateway URL %s", async (claudeGatewayUrl) => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewayUrl }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("clears and applies the Claude gateway URL", async () => {
      settings = {
        ...settings,
        claudeGatewayUrl: "http://localhost:4141",
      };
      const onClaudeGatewaySettingsChanged = vi.fn();
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        onClaudeGatewaySettingsChanged,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeGatewayUrl: null }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeGatewayUrl: undefined,
      });
      expect(onClaudeGatewaySettingsChanged).toHaveBeenCalledWith({
        url: undefined,
        startCommand: undefined,
      });
    });

    it("accepts speech audio retention settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speechAudioRetention: {
            enabled: true,
            maxAgeDays: 56,
            maxBytes: 400 * 1024 * 1024,
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        speechAudioRetention: {
          enabled: true,
          maxAgeDays: 56,
          maxBytes: 400 * 1024 * 1024,
        },
      });
    });

    it("rejects invalid speech audio retention settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          speechAudioRetention: {
            enabled: true,
            maxAgeDays: 0,
            maxBytes: 400 * 1024 * 1024,
          },
        }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("merges server-learned client defaults", async () => {
      settings = {
        ...settings,
        clientDefaults: {
          speech: {
            voiceInputEnabled: false,
          },
          busyComposerDefaultAction: "steer",
          collapsedComposerButton: "primary",
          sessionToolbarPresence: {
            microphone: "hidden",
            slashMenu: "hidden",
          },
        },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            speech: {
              speechMethod: "ya-grok",
              speechSmartTurnSettings: {
                enabled: true,
                threshold: 0.91,
                timeoutMs: 10000,
              },
            },
            sessionToolbarPresence: {
              microphone: "pin",
              waveform: "hidden",
            },
            busyComposerDefaultAction: "queue",
            collapsedComposerButton: "alternate",
            projectQueueCtrlEnterEnabled: false,
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: {
          speech: {
            voiceInputEnabled: false,
            speechMethod: "ya-grok",
            speechSmartTurnSettings: {
              enabled: true,
              threshold: 0.91,
              timeoutMs: 10000,
            },
          },
          busyComposerDefaultAction: "queue",
          collapsedComposerButton: "alternate",
          projectQueueCtrlEnterEnabled: false,
          sessionToolbarPresence: {
            microphone: "pin",
            waveform: "hidden",
            slashMenu: "hidden",
          },
        },
      });
    });

    it("rejects invalid server-learned client defaults", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            collapsedComposerButton: "floating-action-button",
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid clientDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("persists the default-off local command setting as a boolean", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { bangCommandsEnabled: true },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: { bangCommandsEnabled: true },
      });

      const invalid = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { bangCommandsEnabled: "yes" },
        }),
      });
      expect(invalid.status).toBe(400);
    });

    it("merges server-learned session toolbar presence", async () => {
      settings = {
        ...settings,
        clientDefaults: {
          sessionToolbarPresence: {
            modeSelector: "first",
            shortcutsHelp: "last",
          },
        },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            sessionToolbarPresence: {
              modeSelector: "hidden",
              attachments: "pin",
              projectQueueNewSessionShortcut: "hidden",
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: {
          sessionToolbarPresence: {
            modeSelector: "hidden",
            attachments: "pin",
            shortcutsHelp: "last",
            projectQueueNewSessionShortcut: "hidden",
          },
        },
      });
    });

    it("rejects an invalid session toolbar presence value", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            sessionToolbarPresence: { modeSelector: "bogus" },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid clientDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("persists per-model compact thresholds and drops out-of-range entries", async () => {
      settings = { ...settings, clientDefaults: undefined };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: {
            // 150 means "off" for sonnet (>= 100) and is dropped.
            compactAtContextPercent: { opus: 20, sonnet: 150 },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: { compactAtContextPercent: { opus: 20 } },
      });
    });

    it("preserves compact thresholds when another client default changes", async () => {
      settings = {
        ...settings,
        clientDefaults: { compactAtContextPercent: { opus: 20 } },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { steerNowDefault: true },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: {
          compactAtContextPercent: { opus: 20 },
          steerNowDefault: true,
        },
      });
    });

    it("clears compact thresholds when the map empties", async () => {
      settings = {
        ...settings,
        clientDefaults: { compactAtContextPercent: { opus: 20 } },
      };
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { compactAtContextPercent: {} },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        clientDefaults: undefined,
      });
    });

    it("rejects non-numeric compact threshold values", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientDefaults: { compactAtContextPercent: { opus: "20" } },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid clientDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts provider-scoped prompt-cache keepalive settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptCacheKeepalive: {
            providers: {
              claude: {
                mode: "auto",
                inactivityMinutes: 40,
              },
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        promptCacheKeepalive: {
          providers: {
            claude: {
              mode: "auto",
              inactivityMinutes: 40,
            },
          },
        },
      });
    });

    it("accepts provider-scoped cache-billing freshness windows", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cacheMissBilling: {
            enabled: true,
            showToasts: true,
            providerFreshWindowMinutes: {
              claude: 60,
              codex: 10,
            },
            minimumInputTokens: 100_000,
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        cacheMissBilling: {
          enabled: true,
          showToasts: true,
          freshWindowMinutes: 60,
          providerFreshWindowMinutes: {
            claude: 60,
            codex: 10,
          },
          minimumInputTokens: 100_000,
        },
      });
    });

    it("rejects invalid cache-billing freshness windows", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          cacheMissBilling: {
            providerFreshWindowMinutes: {
              unknown: 10,
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("cacheMissBilling must use booleans");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts provider-scoped new-session defaults", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            provider: "codex",
            model: "legacy-codex",
            serviceTier: "legacy-priority",
            providers: {
              claude: {
                model: "opus",
                thinkingMode: "on",
                effortLevel: "high",
                helperSideModel: "haiku",
              },
              codex: {
                model: "gpt-5.5",
                serviceTier: "priority",
                thinkingMode: "auto",
                effortLevel: "xhigh",
                helperSideModel: "helper-target:local-vllm",
              },
            },
          },
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        newSessionDefaults: {
          provider: "codex",
          model: "legacy-codex",
          serviceTier: "legacy-priority",
          providers: {
            claude: {
              model: "opus",
              thinkingMode: "on",
              effortLevel: "high",
              helperSideModel: "haiku",
            },
            codex: {
              model: "gpt-5.5",
              serviceTier: "priority",
              thinkingMode: "auto",
              effortLevel: "xhigh",
              helperSideModel: "helper-target:local-vllm",
            },
          },
        },
      });
    });

    it("accepts exact opt-in Claude model selections", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const selections = [
        {
          id: "claude-opus-4-8",
          label: "Opus 4.8",
          origin: "registry",
        },
        {
          id: "claude-future-6[1m]",
          label: "claude-future-6[1m]",
          origin: "custom",
        },
      ];

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ claudeAdditionalModels: selections }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        claudeAdditionalModels: selections,
      });
    });

    it("rejects duplicate opt-in Claude model ids", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          claudeAdditionalModels: [
            { id: "same", label: "Same", origin: "custom" },
            { id: "same", label: "Same again", origin: "custom" },
          ],
        }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Invalid claudeAdditionalModels setting",
      });
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects invalid provider-scoped helper model defaults", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            providers: {
              claude: { helperSideModel: { id: "haiku" } },
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid newSessionDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects invalid provider-scoped new-session defaults", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          newSessionDefaults: {
            providers: {
              claude: { effortLevel: "extreme" },
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid newSessionDefaults setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("rejects invalid prompt-cache keepalive settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          promptCacheKeepalive: {
            providers: {
              claude: {
                mode: "hidden-message",
                inactivityMinutes: 0,
              },
            },
          },
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toContain("promptCacheKeepalive must configure");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("accepts public share feature gating", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicSharesEnabled: true,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        publicSharesEnabled: true,
      });
    });

    it("accepts and normalizes bare YA client hosts", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaClientBaseUrl: "ya.graehl.org",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        yaClientBaseUrl: "https://ya.graehl.org",
        publicShareViewerBaseUrl: undefined,
      });
    });

    it("accepts legacy public share viewer base URLs", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicShareViewerBaseUrl: "https://example.com/remote/share/",
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        yaClientBaseUrl: "https://example.com/remote",
        publicShareViewerBaseUrl: undefined,
      });
    });

    it("clears YA client base URL for default hosted client", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaClientBaseUrl: null,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        yaClientBaseUrl: undefined,
        publicShareViewerBaseUrl: undefined,
      });
    });

    it("rejects YA client URLs with query strings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          yaClientBaseUrl: "https://example.com?x=1",
        }),
      });

      expect(response.status).toBe(400);
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });

    it("revokes stored public shares when disabling the feature", async () => {
      const revokeAllShares = vi.fn(async () => 2);
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        publicShareService: {
          revokeAllShares,
        } as unknown as PublicShareService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          publicSharesEnabled: false,
        }),
      });

      expect(response.status).toBe(200);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        publicSharesEnabled: false,
      });
      expect(revokeAllShares).toHaveBeenCalled();
    });

    it("accepts and normalizes helper target settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          helperTargets: [
            {
              id: "local-vllm",
              name: "Local vLLM",
              kind: "openai-compatible",
              baseUrl: "localhost:8001",
              model: "",
            },
          ],
        }),
      });

      expect(response.status).toBe(200);
      const json = await response.json();
      expect(json.settings.helperTargets).toEqual([
        {
          id: "local-vllm",
          name: "Local vLLM",
          kind: "openai-compatible",
          baseUrl: "http://localhost:8001/v1",
        },
      ]);
      expect(mockServerSettingsService.updateSettings).toHaveBeenCalledWith({
        helperTargets: [
          {
            id: "local-vllm",
            name: "Local vLLM",
            kind: "openai-compatible",
            baseUrl: "http://localhost:8001/v1",
          },
        ],
      });
    });

    it("rejects invalid helper target settings", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          helperTargets: [
            {
              id: "bad/id",
              name: "Local vLLM",
              kind: "openai-compatible",
              baseUrl: "localhost:8001",
            },
          ],
        }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("Invalid helperTargets setting");
      expect(mockServerSettingsService.updateSettings).not.toHaveBeenCalled();
    });
  });

  describe("GET /host-awake/status", () => {
    it("returns the process-global host status", async () => {
      const status = {
        requestedMode: "off" as const,
        state: "disabled" as const,
        platform: "win32",
        support: {
          idleSleepPrevention: true,
          batteryFloor: true,
          closedLidOnExternalPower: false,
        },
        hasInternalBattery: false,
        powerSource: "external" as const,
        powerObservedAt: 123,
        batteryFloorPercent: 10,
      };
      const hostAwakeService = {
        getStatus: vi.fn(async () => status),
      } as unknown as HostAwakeService;
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
        hostAwakeService,
      });

      const response = await routes.request("/host-awake/status?refresh=1");

      expect(response.status).toBe(200);
      expect(hostAwakeService.getStatus).toHaveBeenCalledWith({
        forceRefresh: true,
      });
      expect(await response.json()).toEqual({ status });
    });
  });

  describe("POST /helper-targets/models", () => {
    it("discovers OpenAI-compatible model ids through the server", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const fetchMock = vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: [
                {
                  id: "Qwen/Qwen3.6-27B",
                  max_model_len: 161072,
                },
              ],
            }),
            {
              status: 200,
              headers: { "Content-Type": "application/json" },
            },
          ),
      );
      vi.stubGlobal("fetch", fetchMock);

      const response = await routes.request("/helper-targets/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: "localhost:8001" }),
      });

      expect(response.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://localhost:8001/v1/models",
        expect.objectContaining({ signal: expect.any(Object) }),
      );
      const json = await response.json();
      expect(json).toEqual({
        baseUrl: "http://localhost:8001/v1",
        models: [
          {
            id: "Qwen/Qwen3.6-27B",
            name: "Qwen/Qwen3.6-27B",
            contextWindow: 161072,
          },
        ],
      });
    });

    it("rejects invalid helper target discovery URLs", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });

      const response = await routes.request("/helper-targets/models", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseUrl: "file:///etc/passwd" }),
      });

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("baseUrl must be an http(s) URL");
    });
  });

  describe("POST /remote-executors/:host/test", () => {
    it("rejects invalid host path parameters", async () => {
      const routes = createSettingsRoutes({
        serverSettingsService: mockServerSettingsService,
      });
      const invalidHost = encodeURIComponent("-oProxyCommand=touch_/tmp/pwned");

      const response = await routes.request(
        `/remote-executors/${invalidHost}/test`,
        {
          method: "POST",
        },
      );

      expect(response.status).toBe(400);
      const json = await response.json();
      expect(json.error).toBe("host must be a valid SSH host alias");
    });
  });
});
