import { BANG_COMMANDS_CAPABILITY } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  bangHistoryViewEnabled,
  serverSupportsBangCommands,
} from "../bangCommandAvailability";

describe("bang command availability", () => {
  it("execution needs only server support", () => {
    expect(serverSupportsBangCommands(undefined)).toBe(false);
    expect(serverSupportsBangCommands({ capabilities: [] })).toBe(false);
    expect(
      serverSupportsBangCommands({
        capabilities: [BANG_COMMANDS_CAPABILITY],
      }),
    ).toBe(true);
  });

  it("the history view requires both server support and an explicit opt-in", () => {
    expect(
      bangHistoryViewEnabled({
        capabilities: [BANG_COMMANDS_CAPABILITY],
      }),
    ).toBe(false);
    expect(
      bangHistoryViewEnabled({
        capabilities: [],
        clientDefaults: { bangCommandsEnabled: true },
      }),
    ).toBe(false);
    expect(
      bangHistoryViewEnabled({
        capabilities: [BANG_COMMANDS_CAPABILITY],
        clientDefaults: { bangCommandsEnabled: true },
      }),
    ).toBe(true);
  });
});
