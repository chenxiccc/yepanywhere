import { afterEach, describe, expect, it, vi } from "vitest";
import type { SubagentMaxDepth } from "@yep-anywhere/shared";
import {
  claudeProvider,
  configureProviderRuntime,
} from "../src/sdk/providers/index.js";
import type {
  ServerSettings,
  ServerSettingsService,
} from "../src/services/ServerSettingsService.js";
import { MockClaudeSDK } from "../src/sdk/mock.js";
import { createApp } from "./setup/create-app.js";

function getClaudeLaunchEnvironment(): Record<string, string | undefined> {
  return (
    claudeProvider as unknown as {
      getEnv(): Record<string, string | undefined>;
    }
  ).getEnv();
}

describe("provider runtime settings", () => {
  const previousOperatorDepth =
    process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;

  afterEach(() => {
    if (previousOperatorDepth === undefined) {
      delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    } else {
      process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = previousOperatorDepth;
    }
    configureProviderRuntime({});
  });

  it("reads the current subagent depth for each provider launch", () => {
    delete process.env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH;
    let subagentMaxDepth: SubagentMaxDepth = 1;
    const getSetting = vi.fn((key: keyof ServerSettings) =>
      key === "subagentMaxDepth" ? subagentMaxDepth : undefined,
    );
    const serverSettingsService = {
      getSetting,
      onSettingsChanged: vi.fn(() => () => {}),
    } as unknown as ServerSettingsService;

    createApp({
      sdk: new MockClaudeSDK(),
      serverSettingsService,
    });

    expect(getClaudeLaunchEnvironment()).toMatchObject({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "1",
    });

    subagentMaxDepth = 4;
    expect(getClaudeLaunchEnvironment()).toMatchObject({
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: "4",
    });

    subagentMaxDepth = null;
    expect(getClaudeLaunchEnvironment()).not.toHaveProperty(
      "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH",
    );
    expect(
      getSetting.mock.calls.filter(([key]) => key === "subagentMaxDepth"),
    ).toHaveLength(3);
  });
});
