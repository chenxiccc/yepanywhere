import {
  SESSION_SANDBOXING_CAPABILITY,
  SESSION_SANDBOXING_STATUS_CAPABILITY,
  SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
} from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { serverHasAvailableSessionSandbox } from "../sessionSandboxAvailability";

describe("serverHasAvailableSessionSandbox", () => {
  it("requires the status contract, usable capability, and available state", () => {
    expect(
      serverHasAvailableSessionSandbox({
        capabilities: [
          SESSION_SANDBOXING_CAPABILITY,
          SESSION_SANDBOXING_STATUS_CAPABILITY,
          SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
        ],
        sessionSandboxing: {
          state: "available",
          platform: "linux",
          backend: "bubblewrap",
          version: "0.4.0",
        },
      }),
    ).toBe(true);
  });

  it.each([
    {
      capabilities: [SESSION_SANDBOXING_CAPABILITY],
      sessionSandboxing: undefined,
    },
    {
      capabilities: [SESSION_SANDBOXING_STATUS_CAPABILITY],
      sessionSandboxing: {
        state: "unsupported-platform" as const,
        platform: "darwin",
      },
    },
    {
      capabilities: [
        SESSION_SANDBOXING_CAPABILITY,
        SESSION_SANDBOXING_STATUS_CAPABILITY,
      ],
      sessionSandboxing: {
        state: "available" as const,
        platform: "linux",
        backend: "bubblewrap" as const,
      },
    },
    {
      capabilities: [
        SESSION_SANDBOXING_CAPABILITY,
        SESSION_SANDBOXING_STATUS_CAPABILITY,
        SESSION_SANDBOX_NETWORK_FIREWALL_CAPABILITY,
      ],
      sessionSandboxing: {
        state: "probe-failed" as const,
        platform: "linux",
        backend: "bubblewrap" as const,
      },
    },
  ])("rejects an unavailable or incomplete advertisement", (source) => {
    expect(serverHasAvailableSessionSandbox(source)).toBe(false);
  });
});
