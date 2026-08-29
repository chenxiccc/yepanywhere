import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPackagedAppOrigin,
  registerServiceWorkerAtStartup,
} from "../registerServiceWorker";

const mocks = vi.hoisted(() => ({
  getServerSettings: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: mocks,
}));

vi.mock("../connection", () => ({
  isRemoteClient: () => false,
}));

describe("isPackagedAppOrigin", () => {
  it("recognizes the transitional Tauri asset origin", () => {
    expect(
      isPackagedAppOrigin({
        hostname: "tauri.localhost",
        protocol: "http:",
      }),
    ).toBe(true);
  });

  it("recognizes the Tauri custom protocol", () => {
    expect(
      isPackagedAppOrigin({
        hostname: "localhost",
        protocol: "tauri:",
      }),
    ).toBe(true);
  });

  it("recognizes the Android app-assets origin", () => {
    expect(
      isPackagedAppOrigin({
        hostname: "appassets.androidplatform.net",
        protocol: "https:",
      }),
    ).toBe(true);
  });

  it("leaves hosted clients eligible for browser service workers", () => {
    expect(
      isPackagedAppOrigin({
        hostname: "latest.yepanywhere.com",
        protocol: "https:",
      }),
    ).toBe(false);
  });
});

describe("registerServiceWorkerAtStartup", () => {
  let serviceWorkerDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    mocks.getServerSettings.mockReset();
    mocks.getServerSettings.mockResolvedValue({
      settings: { serviceWorkerEnabled: true },
    });
    serviceWorkerDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      "serviceWorker",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (serviceWorkerDescriptor) {
      Object.defineProperty(
        navigator,
        "serviceWorker",
        serviceWorkerDescriptor,
      );
    } else {
      Reflect.deleteProperty(navigator, "serviceWorker");
    }
  });

  it("accepts a blocked registration as no registration", async () => {
    const register = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { register },
    });
    const logError = vi.spyOn(console, "error").mockImplementation(() => {});

    await registerServiceWorkerAtStartup();

    expect(register).toHaveBeenCalledTimes(1);
    expect(logError).not.toHaveBeenCalled();
  });
});
