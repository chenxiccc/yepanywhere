import type {
  ProviderName,
  SessionSandboxLevel,
  UrlProjectId,
} from "@yep-anywhere/shared";

export interface PersistedSessionSandbox {
  level: SessionSandboxLevel;
  networkFirewall?: boolean;
  stateKey?: string;
  projectPath: string;
  projectId: UrlProjectId;
  provider?: ProviderName;
}

interface ProcessSandboxState {
  projectId: UrlProjectId;
  projectPath: string;
  provider: ProviderName;
  sandboxEnforcement?: {
    effective: SessionSandboxLevel;
    networkFirewall?: boolean;
  };
  sandboxProjectPath?: string;
  sandboxStateKey?: string;
}

export function persistedSandboxFromProcess(
  process: ProcessSandboxState,
  provider: ProviderName = process.provider,
): PersistedSessionSandbox {
  return {
    level: process.sandboxEnforcement?.effective ?? "none",
    networkFirewall: process.sandboxEnforcement?.networkFirewall,
    stateKey: process.sandboxStateKey,
    projectPath: process.sandboxProjectPath ?? process.projectPath,
    projectId: process.projectId,
    provider,
  };
}
