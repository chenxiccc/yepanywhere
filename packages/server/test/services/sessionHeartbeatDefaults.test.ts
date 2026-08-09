import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import type {
  ProjectMetadataService,
  SessionMetadataService,
} from "../../src/metadata/index.js";
import type { ServerSettingsService } from "../../src/services/ServerSettingsService.js";
import { initializeSessionHeartbeatDefaults } from "../../src/services/sessionHeartbeatDefaults.js";

describe("initializeSessionHeartbeatDefaults", () => {
  it("copies project overrides into a new session", async () => {
    const updateMetadata = vi.fn(async () => undefined);

    await initializeSessionHeartbeatDefaults({
      sessionId: "session-1",
      projectId: toUrlProjectId("/tmp/project"),
      sessionMetadataService: {
        getMetadata: vi.fn(() => undefined),
        updateMetadata,
      } as unknown as SessionMetadataService,
      projectMetadataService: {
        getProjectSessionDefaults: vi.fn(() => ({
          heartbeatTurnsAfterMinutes: 30,
          heartbeatTurnText: "keep going",
          updatedAt: "2026-08-09T00:00:00.000Z",
        })),
      } as unknown as ProjectMetadataService,
    });

    expect(updateMetadata).toHaveBeenCalledWith("session-1", {
      heartbeatTurnsAfterMinutes: 30,
      heartbeatTurnText: "keep going",
    });
  });

  it("inherits missing project values from global settings without overwriting session values", async () => {
    const updateMetadata = vi.fn(async () => undefined);
    const getSetting = vi.fn((key: string) => {
      if (key === "heartbeatTurnsAfterMinutes") return 45;
      if (key === "heartbeatTurnText") return "global message";
      return undefined;
    });

    await initializeSessionHeartbeatDefaults({
      sessionId: "session-1",
      projectId: toUrlProjectId("/tmp/project"),
      sessionMetadataService: {
        getMetadata: vi.fn(() => ({ heartbeatTurnText: "session message" })),
        updateMetadata,
      } as unknown as SessionMetadataService,
      projectMetadataService: {
        getProjectSessionDefaults: vi.fn(() => undefined),
      } as unknown as ProjectMetadataService,
      serverSettingsService: { getSetting } as unknown as ServerSettingsService,
    });

    expect(updateMetadata).toHaveBeenCalledWith("session-1", {
      heartbeatTurnsAfterMinutes: 45,
    });
  });
});
