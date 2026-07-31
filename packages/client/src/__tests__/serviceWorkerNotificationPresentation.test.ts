// @vitest-environment node

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const serviceWorkerSource = readFileSync(
  new URL("../../public/sw.js", import.meta.url),
  "utf8",
);

interface FakeWindowClient {
  focused: boolean;
  url: string;
}

interface PushPayload {
  type: string;
  sessionId?: string;
  projectId?: string;
  projectName?: string;
  summary?: string;
  timestamp: string;
}

function loadServiceWorker() {
  const windowClients: FakeWindowClient[] = [];
  const showNotification = vi.fn(async () => undefined);
  const workerGlobal = {
    addEventListener: vi.fn(),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => windowClients),
    },
    registration: {
      scope: "https://example.test/remote/",
      getNotifications: vi.fn(async () => []),
      showNotification,
    },
  };
  const context = vm.createContext({
    URL,
    console: {
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    },
    self: workerGlobal,
  });
  new vm.Script(serviceWorkerSource, { filename: "sw.js" }).runInContext(
    context,
  );

  const handlePush = vm.runInContext("(data) => handlePush(data)", context) as (
    payload: PushPayload,
  ) => Promise<void>;
  const setNotifyInApp = (enabled: boolean) => {
    vm.runInContext(`settings.notifyInApp = ${String(enabled)}`, context);
  };

  return { handlePush, setNotifyInApp, showNotification, windowClients };
}

function pendingInputPayload(): PushPayload {
  return {
    type: "pending-input",
    sessionId: "session-1",
    projectId: "project-1",
    projectName: "Example",
    summary: "Waiting for approval",
    timestamp: "2026-07-31T12:00:00.000Z",
  };
}

describe("service worker notification presentation", () => {
  it.each([
    ["no YA windows", []],
    [
      "an unfocused YA window",
      [
        {
          focused: false,
          url: "https://example.test/remote/sessions/session-1",
        },
      ],
    ],
  ])("shows an eligible push with %s", async (_label, clients) => {
    const worker = loadServiceWorker();
    worker.windowClients.push(...clients);

    await worker.handlePush(pendingInputPayload());

    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it("suppresses an eligible push while YA is focused by default", async () => {
    const worker = loadServiceWorker();
    worker.windowClients.push({
      focused: true,
      url: "https://example.test/remote/projects",
    });

    await worker.handlePush(pendingInputPayload());

    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("shows a push for another session after the focused-window opt-in", async () => {
    const worker = loadServiceWorker();
    worker.setNotifyInApp(true);
    worker.windowClients.push({
      focused: true,
      url: "https://example.test/remote/sessions/session-2",
    });

    await worker.handlePush(pendingInputPayload());

    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });

  it("still suppresses the session already visible in a focused window", async () => {
    const worker = loadServiceWorker();
    worker.setNotifyInApp(true);
    worker.windowClients.push({
      focused: true,
      url: "https://example.test/remote/sessions/session-1",
    });

    await worker.handlePush(pendingInputPayload());

    expect(worker.showNotification).not.toHaveBeenCalled();
  });

  it("always presents an explicitly requested test push", async () => {
    const worker = loadServiceWorker();
    worker.windowClients.push({
      focused: true,
      url: "https://example.test/remote/sessions/session-1",
    });

    await worker.handlePush({
      type: "test",
      timestamp: "2026-07-31T12:00:00.000Z",
    });

    expect(worker.showNotification).toHaveBeenCalledTimes(1);
  });
});
