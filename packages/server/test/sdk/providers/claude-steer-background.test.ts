import { describe, expect, it, vi } from "vitest";
import { ClaudeSteerBackgroundController } from "../../../src/sdk/providers/claude-steer-background.js";
import type { SDKMessage } from "../../../src/sdk/types.js";

function assistantTools(
  tools: Array<{
    id: string;
    name: string;
    input: Record<string, unknown>;
  }>,
  parentToolUseId?: string,
): SDKMessage {
  return {
    type: "assistant",
    ...(parentToolUseId ? { parent_tool_use_id: parentToolUseId } : {}),
    message: {
      content: tools.map((tool) => ({ type: "tool_use" as const, ...tool })),
    },
  };
}

function toolResult(toolUseId: string): SDKMessage {
  return {
    type: "user",
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId }],
    },
  };
}

describe("ClaudeSteerBackgroundController", () => {
  it("targets only allowed foreground Bash calls", async () => {
    const backgroundTask = vi.fn(async () => true);
    const controller = new ClaudeSteerBackgroundController({
      settings: { allowRegex: "sleep .*", denyRegex: "sleep 5" },
      backgroundTask,
    });
    controller.observe(
      assistantTools([
        { id: "allowed", name: "Bash", input: { command: "sleep 30" } },
        { id: "denied", name: "Bash", input: { command: "sleep 5" } },
        {
          id: "already-backgrounded",
          name: "Bash",
          input: { command: "sleep 30", run_in_background: true },
        },
        { id: "edit", name: "Edit", input: { command: "sleep 30" } },
      ]),
    );
    controller.observe(
      assistantTools(
        [
          {
            id: "subagent-bash",
            name: "Bash",
            input: { command: "sleep 30" },
          },
        ],
        "task-tool-use",
      ),
    );

    await controller.backgroundEligible();

    expect(backgroundTask).toHaveBeenCalledTimes(1);
    expect(backgroundTask).toHaveBeenCalledWith("allowed");
  });

  it("retries an early registration miss for the exact tool id", async () => {
    const backgroundTask = vi
      .fn<(toolUseId: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const retryDelay = vi.fn(async () => {});
    const controller = new ClaudeSteerBackgroundController({
      settings: { allowRegex: ".*", denyRegex: "" },
      backgroundTask,
      retryDelay,
      maxAttempts: 4,
    });
    controller.observe(
      assistantTools([
        { id: "bash-1", name: "Bash", input: { command: "sleep 30" } },
      ]),
    );

    await controller.backgroundEligible();

    expect(backgroundTask).toHaveBeenCalledTimes(3);
    expect(backgroundTask).toHaveBeenNthCalledWith(1, "bash-1");
    expect(backgroundTask).toHaveBeenNthCalledWith(3, "bash-1");
    expect(retryDelay).toHaveBeenCalledTimes(2);
  });

  it("stops retrying when the foreground tool returns", async () => {
    const backgroundTask = vi.fn(async () => false);
    let controller: ClaudeSteerBackgroundController;
    const retryDelay = vi.fn(async () => {
      controller.observe(toolResult("bash-1"));
    });
    controller = new ClaudeSteerBackgroundController({
      settings: { allowRegex: ".*", denyRegex: "" },
      backgroundTask,
      retryDelay,
      maxAttempts: 4,
    });
    controller.observe(
      assistantTools([
        { id: "bash-1", name: "Bash", input: { command: "sleep 1" } },
      ]),
    );

    await controller.backgroundEligible();

    expect(backgroundTask).toHaveBeenCalledTimes(1);
    expect(retryDelay).toHaveBeenCalledTimes(1);
  });

  it("coalesces concurrent retry loops for the same Bash call", async () => {
    let release!: () => void;
    const firstAttempt = new Promise<void>((resolve) => {
      release = resolve;
    });
    const backgroundTask = vi.fn(async () => {
      await firstAttempt;
      return true;
    });
    const controller = new ClaudeSteerBackgroundController({
      settings: { allowRegex: ".*", denyRegex: "" },
      backgroundTask,
    });
    controller.observe(
      assistantTools([
        { id: "bash-1", name: "Bash", input: { command: "sleep 30" } },
      ]),
    );

    const first = controller.backgroundEligible();
    const second = controller.backgroundEligible();
    release();
    await Promise.all([first, second]);

    expect(backgroundTask).toHaveBeenCalledTimes(1);
  });
});
