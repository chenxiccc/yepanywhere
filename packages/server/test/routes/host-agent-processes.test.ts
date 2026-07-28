import type { HostAgentProcessesResponse } from "@yep-anywhere/shared";
import { describe, expect, it, vi } from "vitest";
import { createHostAgentProcessesRoutes } from "../../src/routes/host-agent-processes.js";
import type { HostAgentProcessService } from "../../src/services/HostAgentProcessService.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../../src/services/ServerSettingsService.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";

function createDeps(enabled: boolean) {
  const settings = {
    hostProcessObservabilityEnabled: enabled,
  } as ServerSettings;
  const sampleResponse: HostAgentProcessesResponse = {
    enabled: true,
    supported: true,
    sampledAt: "2026-07-28T12:00:00.000Z",
    observations: [],
  };
  const service = {
    isSupported: vi.fn(() => true),
    clear: vi.fn(),
    sample: vi.fn(async () => sampleResponse),
  } as unknown as HostAgentProcessService;
  const supervisor = {
    getProcessInfoList: vi.fn(() => []),
  } as unknown as Supervisor;
  const serverSettingsService = {
    getSettings: vi.fn(() => settings),
  } as unknown as ServerSettingsService;
  return { service, supervisor, serverSettingsService, sampleResponse };
}

describe("host agent process routes", () => {
  it("clears samples and returns no observations when disabled", async () => {
    const deps = createDeps(false);
    const routes = createHostAgentProcessesRoutes(deps);

    const response = await routes.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: false,
      supported: true,
      observations: [],
    });
    expect(deps.service.clear).toHaveBeenCalledOnce();
    expect(deps.service.sample).not.toHaveBeenCalled();
  });

  it("returns minimized observations from the sampler when enabled", async () => {
    const deps = createDeps(true);
    const routes = createHostAgentProcessesRoutes(deps);

    const response = await routes.request("/");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(deps.sampleResponse);
    expect(deps.service.sample).toHaveBeenCalledWith([]);
  });
});
