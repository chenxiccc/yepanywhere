import { afterEach, describe, expect, it } from "vitest";
import {
  formatDesktopBuildVersion,
  getDesktopRuntimeMetadata,
} from "../desktopRuntime";

afterEach(() => {
  delete window.__YEP_DESKTOP_RUNTIME__;
});

describe("desktop runtime metadata", () => {
  it("reads the native shell and bundled YA versions independently", () => {
    window.__YEP_DESKTOP_RUNTIME__ = {
      desktopVersion: "0.1.1",
      bundledYaVersion: "v0.7.0-204-g02856e2c",
      commit: "02856e2cbe0edae579309ddb747ca8164a0682d3",
    };

    expect(getDesktopRuntimeMetadata()).toEqual({
      desktopVersion: "0.1.1",
      bundledYaVersion: "v0.7.0-204-g02856e2c",
      commit: "02856e2cbe0edae579309ddb747ca8164a0682d3",
    });
  });

  it("does not identify an ordinary browser as a desktop runtime", () => {
    expect(getDesktopRuntimeMetadata()).toBeNull();
    window.__YEP_DESKTOP_RUNTIME__ = { bundledYaVersion: "v0.7.0" };
    expect(getDesktopRuntimeMetadata()).toBeNull();
  });

  it("formats releases and git-describe builds without inventing a version", () => {
    expect(formatDesktopBuildVersion("0.1.1")).toBe("v0.1.1");
    expect(formatDesktopBuildVersion("v0.7.0-204-g02856e2c")).toBe(
      "v0.7.0-204-g02856e2c",
    );
    expect(formatDesktopBuildVersion("02856e2c")).toBe("02856e2c");
  });
});
