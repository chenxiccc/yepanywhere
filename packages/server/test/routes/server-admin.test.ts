import { afterEach, describe, expect, it, vi } from "vitest";
import { triggerServerRestart } from "../../src/routes/server-admin.js";

describe("server admin routes", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("runs restart cleanup before scheduling process exit", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const beforeRestart = vi.fn(async () => {
      order.push("cleanup");
    });
    const exit = vi.fn((code: number) => {
      order.push(`exit:${code}`);
    });

    await triggerServerRestart({
      beforeRestart,
      exit,
      exitDelayMs: 10,
      requestWrapperReload: async () => false,
    });

    expect(beforeRestart).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(order).toEqual(["cleanup"]);

    await vi.advanceTimersByTimeAsync(10);

    expect(exit).toHaveBeenCalledWith(0);
    expect(order).toEqual(["cleanup", "exit:0"]);
  });

  it("continues restart after cleanup timeout", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const exit = vi.fn();

    const restart = triggerServerRestart({
      beforeRestart: () => new Promise(() => {}),
      beforeRestartTimeoutMs: 5,
      exit,
      exitDelayMs: 10,
      requestWrapperReload: async () => false,
    });

    await vi.advanceTimersByTimeAsync(5);
    await restart;

    expect(warn).toHaveBeenCalledWith("[ServerAdmin] Restart cleanup timed out");
    expect(exit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10);

    expect(exit).toHaveBeenCalledWith(0);
  });

  it("uses the acknowledged wrapper reload path without scheduling exit", async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const requestWrapperReload = vi.fn(async () => true);

    await triggerServerRestart({
      exit,
      exitDelayMs: 10,
      requestWrapperReload,
    });
    await vi.advanceTimersByTimeAsync(20);

    expect(requestWrapperReload).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });
});
