import { describe, expect, it } from "vitest";
import {
  APPROVAL_AUDIT_LOG_CAPABILITY,
  BANG_COMMANDS_CAPABILITY,
  BROWSER_SETTINGS_BACKUP_CAPABILITY,
  CLAUDE_GATEWAY_CAPABILITY,
  GIT_SOURCE_REVIEW_CAPABILITY,
  HOST_AWAKE_CONTROL_CAPABILITY,
  HOST_IDENTITY_CAPABILITY,
} from "@yep-anywhere/shared";
import { getServerCapabilities } from "../../src/routes/version.js";

describe("Version Routes", () => {
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

  it("advertises host identity persistence", () => {
    expect(getServerCapabilities()).toContain(HOST_IDENTITY_CAPABILITY);
  });

  it("advertises host-awake settings and status", () => {
    expect(getServerCapabilities()).toContain(HOST_AWAKE_CONTROL_CAPABILITY);
  });

  it("advertises isolated Claude gateway configuration", () => {
    expect(getServerCapabilities()).toContain(CLAUDE_GATEWAY_CAPABILITY);
  });

  it("advertises the complete source browser and review contract", () => {
    expect(getServerCapabilities()).toContain(GIT_SOURCE_REVIEW_CAPABILITY);
  });
});
