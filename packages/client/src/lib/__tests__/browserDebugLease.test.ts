// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  type EvalCommand = { commandId: string; kind: "eval"; code: string };
  let releasePoll: ((command: EvalCommand | null) => void) | null = null;
  let releaseLease: (() => void) | null = null;
  let releaseDelete: (() => void) | null = null;
  let deferLease = false;
  let deferDelete = false;
  let deleteError: Error | null = null;
  let nextCommand: EvalCommand | null = null;
  const evaluatedCode: string[] = [];
  const calls: Array<{
    path: string;
    receiver: unknown;
    options?: RequestInit;
  }> = [];
  const transport = {
    async fetch<T>(
      this: unknown,
      path: string,
      options?: RequestInit,
    ): Promise<T> {
      calls.push({ path, receiver: this, options });
      if (path === "/browser-debug/leases") {
        if (deferLease) {
          await new Promise<void>((resolve) => {
            releaseLease = resolve;
          });
        }
        return {
          lease: {
            leaseId: "lease-1",
            controllerToken: "controller-1",
            grantUrl: "yep-browser-debug://lease-1?grant=grant-1",
            sessionId: "session-1",
            tabId: "tab-1",
            expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
          },
        } as T;
      }
      if (path.endsWith("/poll")) {
        if (nextCommand) {
          const command = nextCommand;
          nextCommand = null;
          return { command } as T;
        }
        return await new Promise<T>((resolve) => {
          releasePoll = (command) => resolve({ command } as T);
        });
      }
      if (options?.method === "DELETE") {
        if (deferDelete) {
          await new Promise<void>((resolve) => {
            releaseDelete = resolve;
          });
        }
        if (deleteError) throw deleteError;
      }
      return {} as T;
    },
  };
  return {
    calls,
    transport,
    queueCommand: (command: typeof nextCommand) => {
      nextCommand = command;
    },
    deferLease: () => {
      deferLease = true;
    },
    deferDelete: () => {
      deferDelete = true;
    },
    releaseLease: () => releaseLease?.(),
    releaseDelete: () => releaseDelete?.(),
    releasePoll: (command: EvalCommand | null = null) => releasePoll?.(command),
    evaluatedCode,
    recordEvaluation: (code: string) => evaluatedCode.push(code),
    failDelete: (error: Error | null) => {
      deleteError = error;
    },
    reset: () => {
      calls.length = 0;
      deferLease = false;
      deferDelete = false;
      releaseLease = null;
      releaseDelete = null;
      releasePoll = null;
      nextCommand = null;
      deleteError = null;
      evaluatedCode.length = 0;
    },
  };
});

vi.mock("../sourceRuntime", () => ({
  getSourceRuntimeRegistry: () => ({
    getCurrentSourceRuntime: () => ({
      sourceKey: "local",
      transport: mocks.transport,
    }),
    getOrCreateSourceRuntime: () => ({
      sourceKey: "local",
      transport: mocks.transport,
    }),
  }),
}));

vi.mock("../browserDebugEval", () => ({
  executeBrowserDebugCode: (code: string) => {
    mocks.recordEvaluation(code);
    if (code === "({ answer: 6 * 7 })") return { answer: 42 };
    if (code === "new Promise(() => {})") {
      throw new Error(
        "Browser diagnostic evaluation exceeded its local deadline",
      );
    }
    throw new Error(`Unexpected test evaluation: ${code}`);
  },
}));

import {
  BROWSER_DEBUG_LEASE_TTL_MS,
  BROWSER_DEBUG_PROMPT_LEAD,
  BrowserDebugLeaseController,
  browserDebugLeaseController,
} from "../browserDebugLease";

describe("browserDebugLeaseController", () => {
  const extraControllers: BrowserDebugLeaseController[] = [];
  const heldPageLocks = new Set<string>();
  const pageLockManager = {
    async request(
      name: string,
      _options: { ifAvailable: true; mode: "exclusive" },
      callback: (lock: unknown | null) => Promise<void> | void,
    ): Promise<void> {
      if (heldPageLocks.has(name)) {
        await callback(null);
        return;
      }
      heldPageLocks.add(name);
      try {
        await callback({ name });
      } finally {
        heldPageLocks.delete(name);
      }
    },
  };

  async function uploadedEvents(
    controller: BrowserDebugLeaseController,
  ): Promise<Array<{ kind: string; data?: Record<string, unknown> }>> {
    await (
      controller as unknown as { flushEvents: () => Promise<void> }
    ).flushEvents();
    return mocks.calls
      .filter((call) => call.path.endsWith("/events"))
      .flatMap((call) => {
        const payload = JSON.parse(String(call.options?.body)) as {
          events: Array<{ kind: string; data?: Record<string, unknown> }>;
        };
        return payload.events;
      });
  }

  beforeEach(() => {
    mocks.reset();
    heldPageLocks.clear();
    Object.defineProperty(window.navigator, "locks", {
      configurable: true,
      value: pageLockManager,
    });
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn(() => 1),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    window.sessionStorage.clear();
  });

  afterEach(async () => {
    await browserDebugLeaseController.disable({ notifyServer: false });
    for (const controller of extraControllers.splice(0)) {
      await controller.disable({ notifyServer: false });
    }
    mocks.releaseLease();
    mocks.releaseDelete();
    mocks.releasePoll();
    Reflect.deleteProperty(window.navigator, "locks");
    vi.unstubAllGlobals();
  });

  it("keeps the source transport receiver while creating a lease", async () => {
    const prompt = await browserDebugLeaseController.enable("session-1");

    expect(prompt.startsWith(BROWSER_DEBUG_PROMPT_LEAD)).toBe(true);
    expect(prompt).toContain(`test -n "\${YEP_BROWSER_DEBUG_AGENT_URL:-}" &&`);
    expect(prompt).toContain(`test -n "\${YEP_BROWSER_DEBUG_CALLER_TOKEN:-}"`);
    expect(prompt).toContain("do not inspect other processes or files");
    expect(prompt).toContain(
      "pnpm --filter server exec tsx src/cli.ts browser-debug --help",
    );
    expect(prompt).toContain(
      "literal usage lines `yepanywhere browser-debug info <grant-url>`",
    );
    expect(prompt).toContain(
      "`yepanywhere browser-debug snapshot <grant-url>`",
    );
    expect(prompt).toContain("<ya-cli> browser-debug snapshot '<grant-url>'");
    expect(prompt).toContain(
      "Do not accept a zero exit status or generic yepanywhere help",
    );
    expect(prompt).toContain("do not treat it as rejection of the grant");
    expect(
      prompt.match(/yep-browser-debug:\/\/lease-1\?grant=grant-1/g),
    ).toHaveLength(1);
    expect(mocks.calls[0]).toEqual({
      path: "/browser-debug/leases",
      receiver: mocks.transport,
      options: {
        method: "POST",
        body: expect.any(String),
      },
    });
    expect(browserDebugLeaseController.getSnapshot()).toMatchObject({
      phase: "active",
      sessionId: "session-1",
    });
  });

  it("executes a brokered evaluation and returns its bounded result", async () => {
    mocks.queueCommand({
      commandId: "command-1",
      kind: "eval",
      code: "({ answer: 6 * 7 })",
    });

    await browserDebugLeaseController.enable("session-1");

    await vi.waitFor(() => {
      expect(mocks.calls.some((call) => call.path.endsWith("/results"))).toBe(
        true,
      );
    });
    const resultCall = mocks.calls.find((call) =>
      call.path.endsWith("/results"),
    );
    expect(JSON.parse(String(resultCall?.options?.body))).toEqual({
      commandId: "command-1",
      result: { ok: true, value: { answer: 42 } },
    });
  });

  it("uploads a deadline failure and resumes polling", async () => {
    mocks.queueCommand({
      commandId: "command-timeout",
      kind: "eval",
      code: "new Promise(() => {})",
    });

    await browserDebugLeaseController.enable("session-1");
    await vi.waitFor(() => {
      expect(
        mocks.calls.filter((call) => call.path.endsWith("/results")),
      ).toHaveLength(1);
    });
    const timeoutResult = mocks.calls.find((call) =>
      call.path.endsWith("/results"),
    );
    const timeoutPayload = JSON.parse(String(timeoutResult?.options?.body)) as {
      commandId: string;
      result: { ok: boolean; error: string };
    };
    expect(timeoutPayload).toMatchObject({
      commandId: "command-timeout",
      result: { ok: false },
    });
    expect(JSON.parse(timeoutPayload.result.error)).toMatchObject({
      name: "Error",
      message: "Browser diagnostic evaluation exceeded its local deadline",
    });

    await vi.waitFor(() => {
      expect(
        mocks.calls.filter((call) => call.path.endsWith("/poll")),
      ).toHaveLength(2);
    });
    mocks.releasePoll({
      commandId: "command-after-timeout",
      kind: "eval",
      code: "({ answer: 6 * 7 })",
    });
    await vi.waitFor(() => {
      expect(
        mocks.calls.filter((call) => call.path.endsWith("/results")),
      ).toHaveLength(2);
    });
  });

  it("measures key-to-frame delay when the callback actually runs", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    let now = 100;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const controller = new BrowserDebugLeaseController();
    extraControllers.push(controller);
    await controller.enable("session-1");
    const input = document.createElement("textarea");
    document.body.append(input);
    const keydown = new KeyboardEvent("keydown", {
      bubbles: true,
      key: "a",
    });
    Object.defineProperty(keydown, "timeStamp", { value: 60 });

    input.dispatchEvent(keydown);
    now = 175;
    frameCallbacks.at(-1)?.(-200);

    const events = await uploadedEvents(controller);
    expect(
      events.find((event) => event.kind === "composer.keystroke-latency"),
    ).toMatchObject({
      data: {
        key: "printable",
        dispatchDelayMs: 40,
        nextFrameDelayMs: 75,
      },
    });
    input.remove();
  });

  it("does not report background time as a foreground frame gap", async () => {
    const frameCallbacks: FrameRequestCallback[] = [];
    let visibility: DocumentVisibilityState = "visible";
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    vi.spyOn(document, "visibilityState", "get").mockImplementation(
      () => visibility,
    );
    vi.stubGlobal(
      "requestAnimationFrame",
      vi.fn((callback: FrameRequestCallback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      }),
    );
    const controller = new BrowserDebugLeaseController();
    extraControllers.push(controller);
    await controller.enable("session-1");

    now = 50;
    frameCallbacks.shift()?.(50);
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    now = 120_000;
    frameCallbacks.shift()?.(120_000);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    now = 120_016;
    frameCallbacks.shift()?.(120_016);
    now = 120_150;
    frameCallbacks.shift()?.(120_150);

    const events = await uploadedEvents(controller);
    expect(
      events
        .filter((event) => event.kind === "performance.frame-gap")
        .map((event) => event.data?.durationMs),
    ).toEqual([134]);
  });

  it("revokes a lease that arrives after enable is cancelled", async () => {
    mocks.deferLease();
    const enable = browserDebugLeaseController.enable("session-1");
    await vi.waitFor(() => expect(mocks.calls).toHaveLength(1));

    await browserDebugLeaseController.disable();
    mocks.releaseLease();

    await expect(enable).rejects.toThrow("enable was cancelled");
    expect(mocks.calls.at(-1)).toMatchObject({
      path: "/browser-debug/leases/lease-1",
      options: {
        method: "DELETE",
        headers: {
          "X-YA-Browser-Debug-Controller": "controller-1",
        },
      },
    });
    expect(browserDebugLeaseController.getSnapshot().phase).toBe("inactive");
  });

  it("closes an expired live lease locally before server revocation", async () => {
    const timeoutSpy = vi.spyOn(globalThis, "setTimeout");
    await browserDebugLeaseController.enable("session-1");
    const expiryCallback = timeoutSpy.mock.calls.find(
      ([, delay]) =>
        typeof delay === "number" && delay > BROWSER_DEBUG_LEASE_TTL_MS - 100,
    )?.[0];
    expect(expiryCallback).toBeTypeOf("function");

    mocks.deferDelete();
    (expiryCallback as () => void)();

    expect(browserDebugLeaseController.getSnapshot().phase).toBe("inactive");
    expect(
      window.sessionStorage.getItem("ya:browser-debug-active-lease-v1"),
    ).toBeNull();
    expect(mocks.calls.at(-1)).toMatchObject({
      path: "/browser-debug/leases/lease-1",
      options: { method: "DELETE" },
    });
    mocks.releaseDelete();
  });

  it("does not execute a command returned after local disable", async () => {
    await browserDebugLeaseController.enable("session-1");

    await browserDebugLeaseController.disable({ notifyServer: false });
    mocks.releasePoll({
      commandId: "command-after-disable",
      kind: "eval",
      code: "({ answer: 6 * 7 })",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(mocks.evaluatedCode).toEqual([]);
    expect(mocks.calls.some((call) => call.path.endsWith("/results"))).toBe(
      false,
    );
  });

  it("resumes a reloaded lease with its original expiry", async () => {
    await browserDebugLeaseController.enable("session-1");
    const expiresAtMs = browserDebugLeaseController.getSnapshot().expiresAtMs;
    const livePoll = mocks.calls.find((call) => call.path.endsWith("/poll"));
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(livePoll?.options?.signal?.aborted).toBe(true);
    const reloadedController = new BrowserDebugLeaseController({
      canRestorePersistedLease: () => true,
    });
    extraControllers.push(reloadedController);

    expect(reloadedController.getSnapshot()).toMatchObject({
      phase: "active",
      connected: false,
      sessionId: "session-1",
      expiresAtMs,
    });

    await reloadedController.reconcilePersistedLease();
    expect(reloadedController.getSnapshot()).toMatchObject({
      phase: "active",
      connected: false,
      expiresAtMs,
    });
    await vi.waitFor(() => {
      expect(reloadedController.getSnapshot()).toMatchObject({
        phase: "active",
        connected: true,
        expiresAtMs,
      });
    });
    mocks.releasePoll();
    expect(
      window.sessionStorage.getItem("ya:browser-debug-active-lease-v1"),
    ).not.toBeNull();
    expect(mocks.calls.some((call) => call.options?.method === "DELETE")).toBe(
      false,
    );
  });

  it("does not let two pages resume the same controller factor", async () => {
    await browserDebugLeaseController.enable("session-1");
    const pollCount = mocks.calls.filter((call) =>
      call.path.endsWith("/poll"),
    ).length;
    const duplicatedController = new BrowserDebugLeaseController({
      canRestorePersistedLease: () => true,
    });
    extraControllers.push(duplicatedController);

    await duplicatedController.reconcilePersistedLease();

    expect(duplicatedController.getSnapshot().phase).toBe("inactive");
    expect(
      mocks.calls.filter((call) => call.path.endsWith("/poll")),
    ).toHaveLength(pollCount);
  });

  it("suspends on page hide and reconnects on page show", async () => {
    await browserDebugLeaseController.enable("session-1");
    const expiresAtMs = browserDebugLeaseController.getSnapshot().expiresAtMs;
    const livePoll = mocks.calls.find((call) => call.path.endsWith("/poll"));
    window.dispatchEvent(new Event("pagehide"));

    expect(livePoll?.options?.signal?.aborted).toBe(true);
    expect(browserDebugLeaseController.getSnapshot()).toMatchObject({
      phase: "active",
      connected: false,
      sessionId: "session-1",
      expiresAtMs,
    });
    expect(
      window.sessionStorage.getItem("ya:browser-debug-active-lease-v1"),
    ).not.toBeNull();
    expect(mocks.calls.some((call) => call.options?.method === "DELETE")).toBe(
      false,
    );

    window.dispatchEvent(new Event("pageshow"));
    await vi.waitFor(() => {
      expect(
        mocks.calls.filter((call) => call.path.endsWith("/poll")),
      ).toHaveLength(2);
    });
    mocks.releasePoll();
    await vi.waitFor(() => {
      expect(browserDebugLeaseController.getSnapshot()).toMatchObject({
        phase: "active",
        connected: true,
        expiresAtMs,
      });
    });

    await vi.waitFor(() => {
      expect(
        mocks.calls.filter((call) => call.path.endsWith("/poll")),
      ).toHaveLength(3);
    });
  });
});
