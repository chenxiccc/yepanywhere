import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_PROJECT_QUEUE_QUIET_SECONDS } from "@yep-anywhere/shared";
import { ServerSettingsService } from "../../src/services/ServerSettingsService.js";

describe("ServerSettingsService", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "server-settings-test-"));
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("uses continue as the default heartbeat turn text", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("heartbeatTurnText")).toBe("continue");
  });

  it("keeps experimental workstreams disabled by default", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("workstreamsEnabled")).toBe(false);
  });

  it("enables host process observability by default and persists opt-out", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();

    expect(service.getSetting("hostProcessObservabilityEnabled")).toBe(true);
    await service.updateSettings({ hostProcessObservabilityEnabled: false });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();
    expect(reloaded.getSetting("hostProcessObservabilityEnabled")).toBe(false);
  });

  it("normalizes malformed host process observability values to enabled", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          hostProcessObservabilityEnabled: "no",
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("hostProcessObservabilityEnabled")).toBe(true);
  });

  it("keeps host-awake default-off with a ten-percent reserve", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("hostAwakeMode")).toBe("off");
    expect(service.getSetting("hostAwakeBatteryFloorPercent")).toBe(10);
  });

  it("normalizes invalid persisted host-awake values to safe defaults", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          hostAwakeMode: "always",
          hostAwakeBatteryFloorPercent: 0,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("hostAwakeMode")).toBe("off");
    expect(service.getSetting("hostAwakeBatteryFloorPercent")).toBe(10);
  });

  it("persists host identity across service instances", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    await service.updateSettings({ hostIdentity: { icon: "💻" } });
    await service.updateSettings({ serviceWorkerEnabled: false });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();

    expect(reloaded.getSetting("hostIdentity")).toEqual({ icon: "💻" });
  });

  it("persists registry provenance without consulting the current catalog", async () => {
    const selection = {
      id: "claude-opus-4-5",
      label: "Opus 4.5",
      origin: "registry" as const,
    };
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    await service.updateSettings({ claudeAdditionalModels: [selection] });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();

    expect(reloaded.getSetting("claudeAdditionalModels")).toEqual([selection]);
  });

  it("persists the optional Claude Gateway start command", async () => {
    const service = new ServerSettingsService({ dataDir: testDir });
    await service.initialize();
    await service.updateSettings({
      claudeGatewayStartCommand: "HOST=localhost gateway start",
    });

    const reloaded = new ServerSettingsService({ dataDir: testDir });
    await reloaded.initialize();

    expect(reloaded.getSetting("claudeGatewayStartCommand")).toBe(
      "HOST=localhost gateway start",
    );
  });

  it("drops malformed persisted Claude Gateway start commands", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          claudeGatewayStartCommand: 42,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("claudeGatewayStartCommand")).toBeUndefined();
  });

  it("drops malformed persisted additional model settings", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          claudeAdditionalModels: [
            {
              id: "model with spaces",
              label: "Invalid",
              origin: "custom",
            },
          ],
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("claudeAdditionalModels")).toBeUndefined();
  });

  it.each([
    "heartbeat",
    "yepanywhere heartbeat",
  ])("migrates legacy built-in heartbeat turn text default %j", async (heartbeatTurnText) => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 1,
        settings: {
          heartbeatTurnText,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("heartbeatTurnText")).toBe("continue");
    const persisted = JSON.parse(
      await fs.readFile(path.join(testDir, "server-settings.json"), "utf-8"),
    ) as { settings: { heartbeatTurnText?: string }; version: number };
    expect(persisted.version).toBe(2);
    expect(persisted.settings.heartbeatTurnText).toBe("continue");
  });

  it("preserves custom heartbeat turn text", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 1,
        settings: {
          heartbeatTurnText: "checking in",
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("heartbeatTurnText")).toBe("checking in");
  });

  it("folds legacy toolbar visibility/priority client defaults into presence", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          clientDefaults: {
            sessionToolbarVisibility: {
              slashMenu: false,
              renderMode: true,
            },
            sessionToolbarPriority: {
              slashMenu: "pin",
              renderMode: "last",
              contextUsage: "mid",
            },
          },
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    const clientDefaults = service.getSetting("clientDefaults") as Record<
      string,
      unknown
    >;
    // Explicit hide wins over the stored tier; other tiers carry over.
    expect(clientDefaults.sessionToolbarPresence).toEqual({
      slashMenu: "hidden",
      renderMode: "last",
      contextUsage: "mid",
    });
    expect(clientDefaults).not.toHaveProperty("sessionToolbarVisibility");
    expect(clientDefaults).not.toHaveProperty("sessionToolbarPriority");
  });

  it("prefers stored presence client defaults over legacy maps", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          clientDefaults: {
            sessionToolbarPresence: { slashMenu: "pin" },
            sessionToolbarVisibility: { slashMenu: false },
          },
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    const clientDefaults = service.getSetting("clientDefaults") as Record<
      string,
      unknown
    >;
    expect(clientDefaults.sessionToolbarPresence).toEqual({
      slashMenu: "pin",
    });
  });

  it("clamps oversized Project Queue quiet-window settings on load", async () => {
    await fs.writeFile(
      path.join(testDir, "server-settings.json"),
      JSON.stringify({
        version: 2,
        settings: {
          projectQueueQuietSeconds: 999,
        },
      }),
      "utf-8",
    );
    const service = new ServerSettingsService({ dataDir: testDir });

    await service.initialize();

    expect(service.getSetting("projectQueueQuietSeconds")).toBe(
      MAX_PROJECT_QUEUE_QUIET_SECONDS,
    );
  });
});
