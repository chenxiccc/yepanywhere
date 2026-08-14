// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  let releasePoll: ((value: { command: null }) => void) | null = null;
  let releaseLease: (() => void) | null = null;
  let deferLease = false;
  let deleteError: Error | null = null;
  let nextCommand: { commandId: string; kind: "eval"; code: string } | null =
    null;
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
          releasePoll = () => resolve({ command: null } as T);
        });
      }
      if (options?.method === "DELETE" && deleteError) throw deleteError;
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
    releaseLease: () => releaseLease?.(),
    releasePoll: () => releasePoll?.({ command: null }),
    failDelete: (error: Error | null) => {
      deleteError = error;
    },
    reset: () => {
      calls.length = 0;
      deferLease = false;
      releaseLease = null;
      releasePoll = null;
      nextCommand = null;
      deleteError = null;
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
    if (code === "({ answer: 6 * 7 })") return { answer: 42 };
    throw new Error(`Unexpected test evaluation: ${code}`);
  },
}));

import {
  BROWSER_DEBUG_PROMPT_LEAD,
  BrowserDebugLeaseController,
  browserDebugLeaseController,
} from "../browserDebugLease";

describe("browserDebugLeaseController", () => {
  const extraControllers: BrowserDebugLeaseController[] = [];

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
    mocks.releasePoll();
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
      "literal usage line `yepanywhere browser-debug info <grant-url>`",
    );
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

  it("shows a reloaded lease as active until revocation is confirmed", async () => {
    await browserDebugLeaseController.enable("session-1");
    const reloadedController = new BrowserDebugLeaseController();
    extraControllers.push(reloadedController);

    expect(reloadedController.getSnapshot()).toMatchObject({
      phase: "active",
      sessionId: "session-1",
    });

    await reloadedController.reconcilePersistedLease();

    expect(reloadedController.getSnapshot().phase).toBe("inactive");
    expect(
      window.sessionStorage.getItem("ya:browser-debug-active-lease-v1"),
    ).toBeNull();
  });

  it("keeps the reload warning when revocation cannot be confirmed", async () => {
    await browserDebugLeaseController.enable("session-1");
    mocks.failDelete(new Error("source disconnected"));
    window.dispatchEvent(new Event("pagehide"));
    await vi.waitFor(() => {
      expect(mocks.calls.at(-1)).toMatchObject({
        options: { method: "DELETE", keepalive: true },
      });
    });
    const reloadedController = new BrowserDebugLeaseController();
    extraControllers.push(reloadedController);

    await reloadedController.reconcilePersistedLease();

    expect(reloadedController.getSnapshot()).toMatchObject({
      phase: "active",
      sessionId: "session-1",
      error: "source disconnected",
    });
    expect(
      window.sessionStorage.getItem("ya:browser-debug-active-lease-v1"),
    ).not.toBeNull();

    mocks.failDelete(null);
    await reloadedController.disable();
    expect(reloadedController.getSnapshot().phase).toBe("inactive");
  });
});
