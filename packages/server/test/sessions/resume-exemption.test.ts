import { describe, expect, it } from "vitest";
import {
  isAutomaticSessionResumeAllowed,
  isUnownedHeartbeatResumeEligible,
} from "../../src/sessions/resume-exemption.js";

describe("resume exemption", () => {
  describe("isAutomaticSessionResumeAllowed", () => {
    it("blocks only sessions with the durable automatic-resume exemption", () => {
      expect(isAutomaticSessionResumeAllowed(undefined)).toBe(true);
      expect(isAutomaticSessionResumeAllowed({})).toBe(true);
      expect(
        isAutomaticSessionResumeAllowed({ autoResumeDisabled: true }),
      ).toBe(false);
    });
  });

  describe("isUnownedHeartbeatResumeEligible", () => {
    it("requires heartbeat opt-in", () => {
      expect(isUnownedHeartbeatResumeEligible({})).toBe(false);
      expect(
        isUnownedHeartbeatResumeEligible({ heartbeatTurnsEnabled: true }),
      ).toBe(true);
    });

    it("exempts archived sessions even with heartbeat enabled", () => {
      expect(
        isUnownedHeartbeatResumeEligible({
          heartbeatTurnsEnabled: true,
          isArchived: true,
        }),
      ).toBe(false);
    });

    it("honors the durable automatic-resume block", () => {
      expect(
        isUnownedHeartbeatResumeEligible({
          heartbeatTurnsEnabled: true,
          autoResumeDisabled: true,
        }),
      ).toBe(false);
    });
  });
});
