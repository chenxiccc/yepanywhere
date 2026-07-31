import { describe, expect, it } from "vitest";
import { isPackagedTauriOrigin } from "../registerServiceWorker";

describe("isPackagedTauriOrigin", () => {
  it("recognizes the Android packaged asset origin", () => {
    expect(
      isPackagedTauriOrigin({
        hostname: "tauri.localhost",
        protocol: "http:",
      }),
    ).toBe(true);
  });

  it("recognizes the Tauri custom protocol", () => {
    expect(
      isPackagedTauriOrigin({
        hostname: "localhost",
        protocol: "tauri:",
      }),
    ).toBe(true);
  });

  it("leaves hosted clients eligible for browser service workers", () => {
    expect(
      isPackagedTauriOrigin({
        hostname: "latest.yepanywhere.com",
        protocol: "https:",
      }),
    ).toBe(false);
  });
});
