import { afterEach, describe, expect, it } from "vitest";
import {
  PiProvider,
  piVersionUsesAgentSettled,
} from "../../../src/sdk/providers/pi.js";

type PiEvent = { type: string; [key: string]: unknown };

const originalPiExecutable = process.env.PI_EXECUTABLE;

afterEach(() => {
  if (originalPiExecutable === undefined) {
    delete process.env.PI_EXECUTABLE;
  } else {
    process.env.PI_EXECUTABLE = originalPiExecutable;
  }
});

function makeStream(terminalEvent: "agent_end" | "agent_settled") {
  return {
    currentAssistantId: null,
    text: "",
    thinking: "",
    lastUsage: null,
    lastCostUsd: null,
    terminalEvent,
    toolStates: new Map(),
  };
}

function mapPiEvent(
  provider: PiProvider,
  event: PiEvent,
  sessionId: string,
  stream: ReturnType<typeof makeStream>,
) {
  const privateProvider = provider as unknown as {
    mapEvent(
      event: PiEvent,
      sessionId: string,
      stream: ReturnType<typeof makeStream>,
    ): unknown[];
  };
  return privateProvider.mapEvent(event, sessionId, stream);
}

describe("PiProvider event mapping", () => {
  it("keeps an unlaunchable explicit path authoritative", async () => {
    process.env.PI_EXECUTABLE = `${process.execPath}.missing-pi`;
    const provider = new PiProvider({ piPath: process.execPath });

    await expect(provider.isInstalled()).resolves.toBe(false);
  });

  it("selects the terminal event from the Pi version boundary", () => {
    expect(piVersionUsesAgentSettled("0.80.3")).toBe(false);
    expect(piVersionUsesAgentSettled("pi 0.80.4")).toBe(true);
    expect(piVersionUsesAgentSettled("0.81.1")).toBe(true);
    expect(piVersionUsesAgentSettled("unknown")).toBeNull();
  });

  it("waits for agent_settled before completing a YA turn", () => {
    const provider = new PiProvider();
    const stream = makeStream("agent_settled");
    const mapEvent = (event: PiEvent) =>
      mapPiEvent(provider, event, "pi-session", stream);

    expect(
      mapEvent({
        type: "turn_end",
        message: {
          usage: {
            input: 11,
            output: 7,
            cacheRead: 5,
            cacheWrite: 3,
            cost: { total: 0.012 },
          },
        },
      }),
    ).toEqual([]);

    expect(
      mapEvent({
        type: "agent_end",
        messages: [],
        willRetry: false,
      }),
    ).toEqual([]);

    expect(mapEvent({ type: "agent_settled" })).toEqual([
      {
        type: "result",
        session_id: "pi-session",
        usage: {
          input_tokens: 11,
          output_tokens: 7,
          cache_read_input_tokens: 5,
          cache_creation_input_tokens: 3,
        },
        total_cost_usd: 0.012,
      },
    ]);
  });

  it("keeps agent_end as the legacy pre-0.80.4 boundary", () => {
    const provider = new PiProvider();
    const stream = makeStream("agent_end");
    const mapEvent = (event: PiEvent) =>
      mapPiEvent(provider, event, "legacy-pi-session", stream);

    expect(mapEvent({ type: "agent_settled" })).toEqual([]);
    expect(mapEvent({ type: "agent_end", willRetry: false })).toEqual([
      {
        type: "result",
        session_id: "legacy-pi-session",
      },
    ]);
  });
});
