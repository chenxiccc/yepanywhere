import type { ModelInfo } from "@yep-anywhere/shared";
import {
  type ManagedSshCodexSessionOptions,
  type ManagedSshCodexSessionResult,
  startManagedSshCodexSession,
} from "./managed-ssh-agent-session.js";
import type {
  AgentProvider,
  AgentSession,
  AuthStatus,
  StartSessionOptions,
} from "./types.js";

export interface ManagedSshCodexDiagnosticProviderOptions
  extends Omit<ManagedSshCodexSessionOptions, "options"> {
  modelId: string;
}

/**
 * Internal operator-only bridge from Supervisor/Process to a fixed managed
 * target lease. It is intentionally absent from provider discovery and every
 * HTTP route; the product contract is deferred until the compatibility gate.
 */
export class ManagedSshCodexDiagnosticProvider implements AgentProvider {
  readonly name = "codex" as const;
  readonly displayName = "Managed SSH Codex diagnostic";
  readonly supportsPermissionMode = true;
  readonly supportsThinkingToggle = true;
  readonly supportsSlashCommands = true;
  readonly supportsSteering = true;
  private latestResult: ManagedSshCodexSessionResult | null = null;

  constructor(
    private readonly config: ManagedSshCodexDiagnosticProviderOptions,
  ) {}

  async isInstalled(): Promise<boolean> {
    return this.config.inspection.codex.available;
  }

  async isAuthenticated(): Promise<boolean> {
    try {
      await this.config.authOwner.preflight();
      return true;
    } catch {
      return false;
    }
  }

  async getAuthStatus(): Promise<AuthStatus> {
    const authenticated = await this.isAuthenticated();
    return {
      installed: this.config.inspection.codex.available,
      authenticated,
      enabled: authenticated,
    };
  }

  async getAvailableModels(): Promise<ModelInfo[]> {
    return [{ id: this.config.modelId, name: this.config.modelId }];
  }

  async startSession(options: StartSessionOptions): Promise<AgentSession> {
    if (options.cwd !== this.config.workspace.remoteWorktreePath) {
      throw new Error(
        "Managed SSH diagnostic session requires its exact target workspace",
      );
    }
    if (options.executor || options.remoteEnv) {
      throw new Error(
        "Managed SSH diagnostic execution cannot use the legacy executor contract",
      );
    }
    if (
      options.sessionSandbox ||
      options.sessionSandboxOptions?.level !== undefined
    ) {
      throw new Error(
        "Managed SSH diagnostic execution cannot project a controller sandbox",
      );
    }
    const result = await startManagedSshCodexSession({
      targetId: this.config.targetId,
      target: this.config.target,
      inspection: this.config.inspection,
      workspace: this.config.workspace,
      artifact: this.config.artifact,
      authOwner: this.config.authOwner,
      expectedCodexVersion: this.config.expectedCodexVersion,
      options: {
        initialMessage: options.initialMessage,
        resumeSessionId: options.resumeSessionId,
        resumeSessionAt: options.resumeSessionAt,
        clientName: options.clientName,
        permissionMode: options.permissionMode,
        model: options.model,
        serviceTier: options.serviceTier,
        thinking: options.thinking,
        effort: options.effort,
        compactAtContextTokenLimit: options.compactAtContextTokenLimit,
        onToolApproval: options.onToolApproval,
        onPermissionModeApplied: options.onPermissionModeApplied,
        shouldEmitLiveDeltas: options.shouldEmitLiveDeltas,
        onProviderRetentionChange: options.onProviderRetentionChange,
      },
    });
    this.latestResult = result;
    return result.session;
  }

  latestSession(): ManagedSshCodexSessionResult | null {
    return this.latestResult;
  }
}
