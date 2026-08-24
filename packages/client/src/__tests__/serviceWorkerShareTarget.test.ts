// @vitest-environment node

import { readFileSync } from "node:fs";
import vm from "node:vm";
import { indexedDB } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimIncomingShare } from "../lib/incomingShare";

const serviceWorkerSource = readFileSync(
  new URL("../../public/sw.js", import.meta.url),
  "utf8",
);
const DB_NAME = "ya-incoming-shares";

interface FakeWindowClient {
  focused: boolean;
  visibilityState?: "hidden" | "visible";
  url: string;
}

async function deleteShareDatabase(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

function loadServiceWorker(
  clients: FakeWindowClient[],
  scope = "https://example.test/",
) {
  const workerGlobal = {
    addEventListener: vi.fn(),
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(async () => undefined),
      matchAll: vi.fn(async () => clients),
    },
    registration: {
      scope,
      getNotifications: vi.fn(async () => []),
      showNotification: vi.fn(async () => undefined),
    },
  };
  const context = vm.createContext({
    Blob,
    Date,
    File,
    Response,
    URL,
    Uint8Array,
    console: {
      error: vi.fn(),
      log: vi.fn(),
      warn: vi.fn(),
    },
    crypto: globalThis.crypto,
    indexedDB,
    self: workerGlobal,
  });
  new vm.Script(serviceWorkerSource, { filename: "sw.js" }).runInContext(
    context,
  );

  return vm.runInContext(
    "(request) => handleShareTargetRequest(request)",
    context,
  ) as (request: { formData: () => Promise<FormData> }) => Promise<Response>;
}

function imageShareRequest(name = "tablet-screenshot.png") {
  const formData = new FormData();
  formData.append(
    "images",
    new File(["image bytes"], name, { type: "image/png" }),
  );
  return { formData: async () => formData };
}

describe("service worker image share target", () => {
  beforeEach(async () => {
    vi.stubGlobal("indexedDB", indexedDB);
    await deleteShareDatabase();
  });

  afterEach(async () => {
    await deleteShareDatabase();
    vi.unstubAllGlobals();
  });

  it("returns an active relay session and stores a one-shot image", async () => {
    const handle = loadServiceWorker([
      {
        focused: false,
        visibilityState: "hidden",
        url: "https://example.test/-/relay/alice/projects/p1/sessions/s1?tailTurns=8",
      },
    ]);

    const response = await handle(imageShareRequest());
    const target = new URL(response.headers.get("location") ?? "");
    const shareId = target.searchParams.get("__ya_share");

    expect(response.status).toBe(303);
    expect(target.pathname).toBe("/-/relay/alice/projects/p1/sessions/s1");
    expect(target.searchParams.get("tailTurns")).toBe("8");
    expect(shareId).toMatch(/^[a-f0-9]{32}$/);

    const files = await claimIncomingShare(shareId ?? "");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      name: "tablet-screenshot.png",
      type: "image/png",
      size: 11,
    });
    await expect(claimIncomingShare(shareId ?? "")).resolves.toEqual([]);
  });

  it("opens New Session in the focused relay context without an active session", async () => {
    const handle = loadServiceWorker(
      [
        {
          focused: true,
          visibilityState: "visible",
          url: "https://example.test/remote/-/relay/alice/projects",
        },
      ],
      "https://example.test/remote/",
    );

    const response = await handle(imageShareRequest());
    const target = new URL(response.headers.get("location") ?? "");

    expect(target.pathname).toBe("/remote/-/relay/alice/new-session");
    expect(target.searchParams.get("__ya_share")).toMatch(/^[a-f0-9]{32}$/);
  });

  it("rejects a share without an image", async () => {
    const handle = loadServiceWorker([]);
    const formData = new FormData();
    formData.append(
      "images",
      new File(["notes"], "notes.txt", { type: "text/plain" }),
    );

    const response = await handle({ formData: async () => formData });

    expect(response.status).toBe(415);
  });
});

describe("web app manifest image share target", () => {
  it("advertises image files through a POST share target", () => {
    const manifest = JSON.parse(
      readFileSync(
        new URL("../../public/manifest.json", import.meta.url),
        "utf8",
      ),
    );

    expect(manifest.share_target).toEqual({
      action: "./share-target",
      method: "POST",
      enctype: "multipart/form-data",
      params: {
        files: [{ name: "images", accept: ["image/*"] }],
      },
    });
  });
});
