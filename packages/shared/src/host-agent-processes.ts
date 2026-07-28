import type { ProviderName } from "./types.js";

export type HostAgentProcessSupervision = "ya" | "external";

/**
 * A deliberately minimized observation of one canonical provider process
 * tree. Command lines, environment, executable paths, and working directories
 * are not part of this wire contract.
 */
export interface HostAgentProcessObservation {
  /** Stable only for this OS process lifetime (PID + process start time). */
  observationId: string;
  pid: number;
  provider: ProviderName;
  supervision: HostAgentProcessSupervision;
  /** Exact join to the existing Supervisor inventory, when YA owns the PID. */
  supervisorProcessId?: string;
  startedAt: string;
  sampledAt: string;
  /** Recent root and logical process-tree CPU deltas. */
  cpu?: {
    rootPercent: number;
    treePercent: number;
    windowMs: number;
  };
  memory: {
    rootRssBytes: number;
    treeRssBytes: number;
    descendantCount: number;
  };
}

export interface HostAgentProcessesResponse {
  enabled: boolean;
  supported: boolean;
  sampledAt?: string;
  observations: HostAgentProcessObservation[];
}
