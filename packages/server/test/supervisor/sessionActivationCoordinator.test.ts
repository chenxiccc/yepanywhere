import { describe, expect, it } from "vitest";
import type { Process } from "../../src/supervisor/Process.js";
import {
  SessionActivationCoordinator,
  type SessionActivationCoordinatorOptions,
} from "../../src/supervisor/SessionActivationCoordinator.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function coordinator(
  overrides: Partial<SessionActivationCoordinatorOptions> = {},
): SessionActivationCoordinator {
  return new SessionActivationCoordinator({
    defaultPermissionMode: "default",
    getProcess: () => undefined,
    getProcessForSession: () => undefined,
    unregisterProcess: () => {},
    assertProviderOwnershipSettled: () => {},
    assertSessionSandboxSettings: () => {},
    restartProcess: async () => null,
    ...overrides,
  });
}

describe("SessionActivationCoordinator", () => {
  it("exposes one settled activation result to concurrent waiters", async () => {
    const activationGate = deferred<Process>();
    const state = coordinator();

    const activation = state.startActivation(
      "session-1",
      () => activationGate.promise,
    );
    const waiter = state.waitForActivation("session-1");
    let waiterSettled = false;
    void waiter.finally(() => {
      waiterSettled = true;
    });

    await Promise.resolve();
    expect(waiterSettled).toBe(false);

    const process = { id: "process-1" } as Process;
    activationGate.resolve(process);
    await expect(activation).resolves.toBe(process);
    await expect(waiter).resolves.toBe(true);
    await expect(state.waitForActivation("session-1")).resolves.toBe(false);
  });

  it("runs configuration transitions in request order", async () => {
    const firstGate = deferred<void>();
    const state = coordinator();
    const transitions: string[] = [];

    const first = state.enqueueConfiguration("session-1", async () => {
      transitions.push("first-start");
      await firstGate.promise;
      transitions.push("first-end");
      return 1;
    });
    const second = state.enqueueConfiguration("session-1", async () => {
      transitions.push("second");
      return 2;
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(transitions).toEqual(["first-start"]);

    firstGate.resolve();
    await expect(first).resolves.toBe(1);
    await expect(second).resolves.toBe(2);
    expect(transitions).toEqual(["first-start", "first-end", "second"]);
  });
});
