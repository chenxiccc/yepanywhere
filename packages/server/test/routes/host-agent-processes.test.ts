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
  let settingsListener:
    | ((
        settings: Readonly<ServerSettings>,
        previousSettings: Readonly<ServerSettings>,
      ) => void)
    | undefined;
  const serverSettingsService = {
    getSettings: vi.fn(() => settings),
    onSettingsChanged: vi.fn((listener) => {
      settingsListener = listener;
      return () => {
        settingsListener = undefined;
      };
    }),
  } as unknown as ServerSettingsService;
  return {
    service,
    supervisor,
    serverSettingsService,
    sampleResponse,
    notifySettingsChanged(
      next: Pick<ServerSettings, "hostProcessObservabilityEnabled">,
      previous: Pick<ServerSettings, "hostProcessObservabilityEnabled">,
    ) {
      settings.hostProcessObservabilityEnabled =
        next.hostProcessObservabilityEnabled;
      settingsListener?.(next as ServerSettings, previous as ServerSettings);
    },
  };
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

  it("clears retained samples as soon as the setting is disabled", () => {
    const deps = createDeps(true);
    createHostAgentProcessesRoutes(deps);

    deps.notifySettingsChanged(
      { hostProcessObservabilityEnabled: false },
      { hostProcessObservabilityEnabled: true },
    );

    expect(deps.service.clear).toHaveBeenCalledOnce();
  });

  it("does not return a sample completed after observation is disabled", async () => {
    const deps = createDeps(true);
    let resolveSample!: (response: HostAgentProcessesResponse) => void;
    vi.mocked(deps.service.sample).mockReturnValue(
      new Promise((resolve) => {
        resolveSample = resolve;
      }),
    );
    const routes = createHostAgentProcessesRoutes(deps);

    const request = routes.request("/");
    await vi.waitFor(() => {
      expect(deps.service.sample).toHaveBeenCalledOnce();
    });
    deps.notifySettingsChanged(
      { hostProcessObservabilityEnabled: false },
      { hostProcessObservabilityEnabled: true },
    );
    resolveSample(deps.sampleResponse);

    const response = await request;
    expect(await response.json()).toEqual({
      enabled: false,
      supported: true,
      observations: [],
    });
  });
});
