// @vitest-environment node

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";

const serviceWorkerSource = readFileSync(
  new URL("../../public/sw.js", import.meta.url),
  "utf8",
);

type WorkerListener = (event: {
  request?: { mode: string; url: string };
  respondWith?: (pending: Promise<unknown>) => void;
  waitUntil?: (pending: Promise<unknown>) => void;
}) => void;

function loadServiceWorker(scope = "https://example.test/") {
  const listeners = new Map<string, WorkerListener>();
  const claim = vi.fn(async () => undefined);
  const fetch = vi.fn(async () => ({ ok: true }));
  const workerGlobal = {
    addEventListener: vi.fn((type: string, listener: WorkerListener) => {
      listeners.set(type, listener);
    }),
    skipWaiting: vi.fn(),
    clients: {
      claim,
      matchAll: vi.fn(async () => [
        {
          focused: true,
          url: "https://example.test/projects/example/sessions/old-client",
        },
      ]),
    },
    registration: {
      scope,
      getNotifications: vi.fn(async () => []),
      showNotification: vi.fn(async () => undefined),
    },
  };
  const context = vm.createContext({
    URL,
    console: {
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    },
    fetch,
    self: workerGlobal,
  });
  new vm.Script(serviceWorkerSource, { filename: "sw.js" }).runInContext(
    context,
  );

  return { claim, fetch, listeners };
}

describe("service worker frontend reload", () => {
  it("claims an older open client without reloading it", async () => {
    const worker = loadServiceWorker();
    let activation: Promise<unknown> | undefined;

    worker.listeners.get("activate")?.({
      waitUntil: (pending) => {
        activation = pending;
      },
    });
    await activation;

    expect(worker.claim).toHaveBeenCalledOnce();
  });

  it("reloads the host picker document from the network", async () => {
    const worker = loadServiceWorker();
    const request = {
      mode: "navigate",
      url: "https://example.test/login",
    };
    let response: Promise<unknown> | undefined;

    worker.listeners.get("fetch")?.({
      request,
      respondWith: (pending) => {
        response = pending;
      },
    });
    await response;

    expect(worker.fetch).toHaveBeenCalledWith(request, { cache: "reload" });
  });

  it("reloads a host picker below the service worker scope", async () => {
    const worker = loadServiceWorker("https://example.test/remote/");
    const request = {
      mode: "navigate",
      url: "https://example.test/remote/login",
    };
    let response: Promise<unknown> | undefined;

    worker.listeners.get("fetch")?.({
      request,
      respondWith: (pending) => {
        response = pending;
      },
    });
    await response;

    expect(worker.fetch).toHaveBeenCalledWith(request, { cache: "reload" });
  });

  it("keeps ordinary navigation on revalidation", async () => {
    const worker = loadServiceWorker();
    const request = {
      mode: "navigate",
      url: "https://example.test/projects",
    };
    let response: Promise<unknown> | undefined;

    worker.listeners.get("fetch")?.({
      request,
      respondWith: (pending) => {
        response = pending;
      },
    });
    await response;

    expect(worker.fetch).toHaveBeenCalledWith(request, {
      cache: "no-cache",
    });
  });
});
