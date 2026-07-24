import { BANG_COMMANDS_CAPABILITY } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  bangCommandsAreEnabled,
  serverSupportsBangCommands,
} from "../bangCommandAvailability";

describe("bang command availability", () => {
  it("requires both server support and an explicit opt-in", () => {
    expect(serverSupportsBangCommands(undefined)).toBe(false);
    expect(
      bangCommandsAreEnabled({
        capabilities: [BANG_COMMANDS_CAPABILITY],
      }),
    ).toBe(false);
    expect(
      bangCommandsAreEnabled({
        capabilities: [],
        clientDefaults: { bangCommandsEnabled: true },
      }),
    ).toBe(false);
    expect(
      bangCommandsAreEnabled({
        capabilities: [BANG_COMMANDS_CAPABILITY],
        clientDefaults: { bangCommandsEnabled: true },
      }),
    ).toBe(true);
  });
});
