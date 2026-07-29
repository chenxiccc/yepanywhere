import type { HostAgentProcessesResponse } from "@yep-anywhere/shared";
import { Hono } from "hono";
import { HostAgentProcessService } from "../services/HostAgentProcessService.js";
import type { ServerSettingsService } from "../services/ServerSettingsService.js";
import type { Supervisor } from "../supervisor/Supervisor.js";

export interface HostAgentProcessesRoutesDeps {
  supervisor: Supervisor;
  serverSettingsService: ServerSettingsService;
  service?: HostAgentProcessService;
}

export function createHostAgentProcessesRoutes(
  deps: HostAgentProcessesRoutesDeps,
) {
  const routes = new Hono();
  const service = deps.service ?? new HostAgentProcessService();
  deps.serverSettingsService.onSettingsChanged((settings, previousSettings) => {
    if (
      previousSettings.hostProcessObservabilityEnabled &&
      !settings.hostProcessObservabilityEnabled
    ) {
      service.clear();
    }
  });
  const disabledResponse = (): HostAgentProcessesResponse => ({
    enabled: false,
    supported: service.isSupported(),
    observations: [],
  });

  routes.get("/", async (c) => {
    if (
      !deps.serverSettingsService.getSettings().hostProcessObservabilityEnabled
    ) {
      service.clear();
      return c.json(disabledResponse());
    }

    try {
      const response = await service.sample(
        deps.supervisor.getProcessInfoList(),
      );
      if (
        !deps.serverSettingsService.getSettings()
          .hostProcessObservabilityEnabled
      ) {
        service.clear();
        return c.json(disabledResponse());
      }
      return c.json(response);
    } catch {
      return c.json({ error: "Host process observation failed" }, 503);
    }
  });

  return routes;
}
