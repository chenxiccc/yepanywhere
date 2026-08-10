export const CAPABILITY_ID_ENCODING_VERSION = 1;
export const CAPABILITY_ID_ENCODING_INTRODUCED_IN = "0.7.1";

export type CapabilityDirection = "client" | "server";

export interface CapabilityIdAllocation {
  id: number;
  direction: CapabilityDirection;
  name: string;
  introducedIn: string;
}

/**
 * Permanent capability identity ledger.
 *
 * IDs are global across both directions, append-only, and never reused. The
 * first six entries preserve the optional server-bit assignments shipped
 * before the general 0.7.1 ID contract.
 */
export const CAPABILITY_ID_ALLOCATIONS = {
  voiceInput: {
    id: 0,
    direction: "server",
    name: "voiceInput",
    introducedIn: "0.6.0",
  },
  deviceBridgeAvailable: {
    id: 1,
    direction: "server",
    name: "deviceBridge-available",
    introducedIn: "0.6.0",
  },
  deviceBridge: {
    id: 2,
    direction: "server",
    name: "deviceBridge",
    introducedIn: "0.6.0",
  },
  deviceBridgeDownload: {
    id: 3,
    direction: "server",
    name: "deviceBridge-download",
    introducedIn: "0.6.0",
  },
  deviceBridgeUpdate: {
    id: 4,
    direction: "server",
    name: "deviceBridge-update",
    introducedIn: "0.6.0",
  },
  browserSettingsBackup: {
    id: 5,
    direction: "server",
    name: "browser-settings-backup",
    introducedIn: "0.6.3",
  },
  securityClientAudit: {
    id: 6,
    direction: "server",
    name: "security-client-audit-v1",
    introducedIn: "0.7.1",
  },
  reloadSafeCodexRuntime: {
    id: 7,
    direction: "server",
    name: "reload-safe-codex-runtime",
    introducedIn: "0.7.1",
  },
  sessionSandboxing: {
    id: 8,
    direction: "server",
    name: "session-sandboxing",
    introducedIn: "0.7.1",
  },
  publicShareManagement: {
    id: 9,
    direction: "server",
    name: "public-share-management",
    introducedIn: "0.7.1",
  },
  glossaryTooltips: {
    id: 10,
    direction: "server",
    name: "glossary-tooltips",
    introducedIn: "0.7.1",
  },
  progressiveSessionCatalog: {
    id: 11,
    direction: "server",
    name: "progressive-session-catalog",
    introducedIn: "0.7.1",
  },
  projectDirectoryStoragePolicy: {
    id: 12,
    direction: "server",
    name: "project-directory-storage-policy",
    introducedIn: "0.7.1",
  },
  idleReapHoursSetting: {
    id: 13,
    direction: "server",
    name: "idle-reap-hours-setting",
    introducedIn: "0.7.1",
  },
  toolResultMediaPreservationPolicy: {
    id: 14,
    direction: "server",
    name: "tool-result-media-preservation-policy",
    introducedIn: "0.7.1",
  },
  gitDirtyFileEditor: {
    id: 15,
    direction: "server",
    name: "git-dirty-file-editor",
    introducedIn: "0.7.1",
  },
  gitSourceReview: {
    id: 16,
    direction: "server",
    name: "git-source-review",
    introducedIn: "0.7.1",
  },
  gitSourceReviewSubmissions: {
    id: 17,
    direction: "server",
    name: "git-source-review-submissions",
    introducedIn: "0.7.1",
  },
  gitSourceReviewProjections: {
    id: 18,
    direction: "server",
    name: "git-source-review-projections",
    introducedIn: "0.7.1",
  },
  claudeGateway: {
    id: 19,
    direction: "server",
    name: "claude-gateway",
    introducedIn: "0.7.1",
  },
  claudeGatewayAutostart: {
    id: 20,
    direction: "server",
    name: "claude-gateway-autostart",
    introducedIn: "0.7.1",
  },
  claudeGatewayDisableAgent: {
    id: 21,
    direction: "server",
    name: "claude-gateway-disable-agent",
    introducedIn: "0.7.1",
  },
  providerSubscriptionUsage: {
    id: 22,
    direction: "server",
    name: "provider-subscription-usage",
    introducedIn: "0.7.1",
  },
  reloadSafeCodexRuntimeSettings: {
    id: 23,
    direction: "server",
    name: "reload-safe-codex-runtime-settings",
    introducedIn: "0.7.1",
  },
  hostAgentProcessObservability: {
    id: 24,
    direction: "server",
    name: "host-agent-process-observability",
    introducedIn: "0.7.1",
  },
  sessionSandboxingStatus: {
    id: 25,
    direction: "server",
    name: "session-sandboxing-status",
    introducedIn: "0.7.1",
  },
  projectSessionDefaults: {
    id: 26,
    direction: "server",
    name: "project-session-defaults",
    introducedIn: "0.7.1",
  },
  sidebarSessionResume: {
    id: 27,
    direction: "server",
    name: "sidebar-session-resume",
    introducedIn: "0.7.1",
  },
  sessionForkTurnIntents: {
    id: 28,
    direction: "server",
    name: "session-fork-turn-intents",
    introducedIn: "0.7.1",
  },
} as const satisfies Record<string, CapabilityIdAllocation>;

export type CapabilityBitset = readonly (readonly [
  wordIndex: number,
  bits: number,
])[];

export function encodeCapabilityIds(ids: Iterable<number>): CapabilityBitset {
  const words = new Map<number, number>();
  for (const id of ids) {
    if (!Number.isInteger(id) || id < 0) {
      throw new Error(`Invalid capability ID: ${id}`);
    }
    const wordIndex = Math.floor(id / 32);
    const mask = 2 ** (id % 32);
    const current = words.get(wordIndex) ?? 0;
    if (Math.floor(current / mask) % 2 === 0) {
      words.set(wordIndex, current + mask);
    }
  }
  return [...words.entries()].sort(([left], [right]) => left - right);
}

export function capabilityBitIsSet(
  bitset: CapabilityBitset | undefined,
  id: number,
): boolean {
  const wordIndex = Math.floor(id / 32);
  const mask = 2 ** (id % 32);
  for (const [candidateWordIndex, bits] of bitset ?? []) {
    if (
      candidateWordIndex === wordIndex &&
      Number.isSafeInteger(bits) &&
      bits >= 0 &&
      bits <= 0xffff_ffff
    ) {
      return Math.floor(bits / mask) % 2 === 1;
    }
  }
  return false;
}

export function isCapabilityBitset(value: unknown): value is CapabilityBitset {
  return (
    Array.isArray(value) &&
    value.every(
      (word) =>
        Array.isArray(word) &&
        word.length === 2 &&
        Number.isSafeInteger(word[0]) &&
        word[0] >= 0 &&
        Number.isSafeInteger(word[1]) &&
        word[1] >= 0 &&
        word[1] <= 0xffff_ffff,
    )
  );
}
