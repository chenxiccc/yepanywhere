import { describe, expect, it } from "vitest";
import { isPackagedAppOrigin } from "../registerServiceWorker";

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
