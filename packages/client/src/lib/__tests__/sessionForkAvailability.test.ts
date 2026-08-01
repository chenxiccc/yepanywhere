import { SESSION_FORK_TURN_INTENTS_CAPABILITY } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { supportsUnifiedSessionFork } from "../sessionForkAvailability";

describe("supportsUnifiedSessionFork", () => {
  it("requires both the server intent contract and provider primitive", () => {
    const capableServer = {
      capabilities: [SESSION_FORK_TURN_INTENTS_CAPABILITY],
    };
    expect(supportsUnifiedSessionFork(capableServer, true)).toBe(true);
    expect(supportsUnifiedSessionFork(capableServer, false)).toBe(false);
    expect(supportsUnifiedSessionFork({ capabilities: [] }, true)).toBe(false);
    expect(supportsUnifiedSessionFork(undefined, true)).toBe(false);
  });
});
