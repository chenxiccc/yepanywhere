import { describe, expect, it } from "vitest";
import {
  isBrowserAppRoutePath,
  toBrowserAppHref,
  toBrowserAssetHref,
} from "../appHref";

describe("browser application URLs", () => {
  it.each([
    ["/", "/login", "/login"],
    ["/remote/", "/login", "/remote/login"],
    ["/remote", "projects", "/remote/projects"],
  ])("formats %s base app paths", (baseUrl, path, expected) => {
    expect(toBrowserAppHref(path, baseUrl)).toBe(expected);
  });

  it.each([
    ["/", "sw.js", "/sw.js"],
    ["/remote/", "sw.js", "/remote/sw.js"],
  ])(
    "keeps service worker assets inside the %s base",
    (baseUrl, path, expected) => {
      expect(toBrowserAssetHref(path, baseUrl)).toBe(expected);
    },
  );

  it.each([
    ["/login", "/", true],
    ["/login/relay", "/", true],
    ["/remote/login", "/remote/", true],
    ["/remote/login/direct", "/remote/", true],
    ["/remote/login-extra", "/remote/", false],
    ["/login", "/remote/", false],
  ])(
    "classifies %s against the %s base login route",
    (pathname, baseUrl, expected) => {
      expect(isBrowserAppRoutePath(pathname, "/login", baseUrl)).toBe(expected);
    },
  );
});
