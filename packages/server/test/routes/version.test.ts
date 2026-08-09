import { describe, expect, it } from "vitest";
import {
  APPROVAL_AUDIT_LOG_CAPABILITY,
  BANG_COMMANDS_CAPABILITY,
  BROWSER_SETTINGS_BACKUP_CAPABILITY,
  CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
  GIT_DIRTY_FILE_EDITOR_CAPABILITY,
  GLOSSARY_TOOLTIPS_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
  HOST_AWAKE_CONTROL_CAPABILITY,
  HOST_IDENTITY_CAPABILITY,
  IDLE_REAP_HOURS_SETTING_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY,
  RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_FORK_TURN_INTENTS_CAPABILITY,
  SECURITY_CLIENT_AUDIT_CAPABILITY,
} from "@yep-anywhere/shared";
import { getServerCapabilities } from "../../src/routes/version.js";

describe("Version Routes", () => {
  it("advertises compiled glossary artifacts", () => {
    expect(getServerCapabilities()).toContain(GLOSSARY_TOOLTIPS_CAPABILITY);
  });

  it("advertises approval audit log control", () => {
    expect(getServerCapabilities()).toContain(APPROVAL_AUDIT_LOG_CAPABILITY);
  });

  it("advertises explicitly enabled local command support", () => {
    expect(getServerCapabilities()).toContain(BANG_COMMANDS_CAPABILITY);
  });

  it("advertises browser settings backup storage", () => {
    expect(
      getServerCapabilities({ browserSettingsBackupAvailable: true }),
    ).toContain(BROWSER_SETTINGS_BACKUP_CAPABILITY);
    expect(getServerCapabilities()).not.toContain(
      BROWSER_SETTINGS_BACKUP_CAPABILITY,
    );
  });

  it("advertises security-client audit only when its routes are mounted", () => {
    expect(
      getServerCapabilities({ securityClientAuditAvailable: true }),
    ).toContain(SECURITY_CLIENT_AUDIT_CAPABILITY);
    expect(getServerCapabilities()).not.toContain(
      SECURITY_CLIENT_AUDIT_CAPABILITY,
    );
  });

  it("advertises host identity persistence", () => {
    expect(getServerCapabilities()).toContain(HOST_IDENTITY_CAPABILITY);
  });

  it("advertises host-awake settings and status", () => {
    expect(getServerCapabilities()).toContain(HOST_AWAKE_CONTROL_CAPABILITY);
  });

  it("advertises configurable idle provider reaping", () => {
    expect(getServerCapabilities()).toContain(
      IDLE_REAP_HOURS_SETTING_CAPABILITY,
    );
  });

  it("advertises isolated Claude gateway configuration", () => {
    expect(getServerCapabilities()).toContain(CLAUDE_GATEWAY_CAPABILITY);
    expect(getServerCapabilities()).toContain(
      CLAUDE_GATEWAY_AUTOSTART_CAPABILITY,
    );
    expect(getServerCapabilities()).toContain(
      CLAUDE_GATEWAY_DISABLE_AGENT_CAPABILITY,
    );
  });

  it("separates reload-safe Codex settings from host availability", () => {
    expect(getServerCapabilities()).toContain(
      RELOAD_SAFE_CODEX_RUNTIME_SETTINGS_CAPABILITY,
    );
    expect(getServerCapabilities()).not.toContain(
      RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY,
    );
    expect(
      getServerCapabilities({ reloadSafeCodexRuntimeAvailable: true }),
    ).toContain(RELOAD_SAFE_CODEX_RUNTIME_CAPABILITY);
  });

  it("advertises the complete source browser and review contract", () => {
    expect(getServerCapabilities()).toContain(GIT_SOURCE_REVIEW_CAPABILITY);
  });

  it("advertises dirty-file editor attribution", () => {
    expect(getServerCapabilities()).toContain(GIT_DIRTY_FILE_EDITOR_CAPABILITY);
  });

  it("advertises Source Control diff projections", () => {
    expect(getServerCapabilities()).toContain(
      GIT_SOURCE_REVIEW_PROJECTIONS_CAPABILITY,
    );
  });

  it("advertises sandbox status but only advertises use when preflight passes", () => {
    expect(getServerCapabilities()).toContain(
      SESSION_SANDBOXING_STATUS_CAPABILITY,
    );
    expect(getServerCapabilities()).not.toContain(
      SESSION_SANDBOXING_CAPABILITY,
    );
    expect(
      getServerCapabilities({
        sessionSandboxAvailability: {
          state: "available",
          platform: "linux",
          backend: "bubblewrap",
          version: "0.4.0",
        },
      }),
    ).toContain(SESSION_SANDBOXING_CAPABILITY);
  });

  it("advertises server-resolved session fork intents", () => {
    expect(getServerCapabilities()).toContain(
      SESSION_FORK_TURN_INTENTS_CAPABILITY,
    );
  });
});
