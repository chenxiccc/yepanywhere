import { describe, expect, it } from "vitest";
import {
  DESKTOP_BOOTSTRAP_PROTOCOL_VERSION,
  DesktopBootstrapService,
} from "../../src/desktop/DesktopBootstrapService.js";

const MASTER_SECRET = "m".repeat(64);

describe("DesktopBootstrapService", () => {
  it("uses a versioned protocol and validates the master secret", () => {
    expect(DESKTOP_BOOTSTRAP_PROTOCOL_VERSION).toBe(1);
    const service = new DesktopBootstrapService({
      masterSecret: MASTER_SECRET,
    });

    expect(service.validateMasterSecret(MASTER_SECRET)).toBe(true);
    expect(service.validateMasterSecret("x".repeat(64))).toBe(false);
    expect(service.validateMasterSecret(undefined)).toBe(false);
  });

  it("consumes a bootstrap code exactly once", () => {
    const service = new DesktopBootstrapService({
      masterSecret: MASTER_SECRET,
    });
    const { code, expiresInMs } = service.mintCode();

    expect(expiresInMs).toBe(30_000);
    const session = service.consumeCode(code);
    expect(session).toBeTruthy();
    expect(service.validateSession(session ?? undefined)).toBe(true);
    expect(service.consumeCode(code)).toBeNull();
  });

  it("rejects expired codes", () => {
    let now = 1_000;
    const service = new DesktopBootstrapService({
      masterSecret: MASTER_SECRET,
      codeTtlMs: 50,
      now: () => now,
    });
    const { code } = service.mintCode();

    now += 51;
    expect(service.consumeCode(code)).toBeNull();
  });

  it("expires and bounds desktop sessions", () => {
    let now = 1_000;
    const service = new DesktopBootstrapService({
      masterSecret: MASTER_SECRET,
      sessionTtlMs: 50,
      maxActiveSessions: 1,
      now: () => now,
    });
    const first = service.consumeCode(service.mintCode().code);
    const second = service.consumeCode(service.mintCode().code);

    expect(service.validateSession(first ?? undefined)).toBe(false);
    expect(service.validateSession(second ?? undefined)).toBe(true);

    now += 51;
    expect(service.validateSession(second ?? undefined)).toBe(false);
  });

  it("bounds active codes and invalid bootstrap attempts", () => {
    const service = new DesktopBootstrapService({
      masterSecret: MASTER_SECRET,
      maxActiveCodes: 1,
      maxInvalidAttemptsPerMinute: 2,
    });
    const first = service.mintCode().code;
    const second = service.mintCode().code;

    expect(service.consumeCode(first)).toBeNull();
    expect(service.canAttemptBootstrap()).toBe(true);
    expect(service.consumeCode("not-a-code")).toBeNull();
    expect(service.canAttemptBootstrap()).toBe(false);
    expect(service.consumeCode(second)).toBeTruthy();
  });

  it("does not accept short master secrets", () => {
    expect(
      () =>
        new DesktopBootstrapService({
          masterSecret: "short",
        }),
    ).toThrow("too short");
  });
});
