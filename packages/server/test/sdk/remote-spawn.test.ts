import { describe, expect, it } from "vitest";
import {
  homeRelativeSuffix,
  toRemotePath,
  translateHomePath,
} from "../../src/sdk/remote-spawn.js";

describe("home-relative path containment", () => {
  it.each([
    ["/home/user", "/home/user", ""],
    ["/home/user/repo", "/home/user", "/repo"],
    ["/home/user/a/b", "/home/user/", "/a/b"],
    ["C:\\Users\\dev", "C:\\Users\\dev", ""],
    ["C:\\Users\\dev\\repo", "C:\\Users\\dev", "\\repo"],
    ["C:\\Users\\Dev\\repo", "C:\\Users\\dev", "\\repo"],
    [
      "\\\\SERVER\\Share\\User\\repo\\nested",
      "\\\\server\\share\\user",
      "\\repo\\nested",
    ],
  ])("splits %j against home %j", (localPath, home, suffix) => {
    expect(homeRelativeSuffix(localPath, home)).toBe(suffix);
  });

  it.each([
    // Sibling directories sharing the home string prefix are not descendants.
    ["/home/user-backup/repo", "/home/user"],
    ["/home/username/repo", "/home/user"],
    ["C:\\Users\\devops\\repo", "C:\\Users\\dev"],
    ["\\\\server\\share-two\\user", "\\\\server\\share\\user"],
    ["/var/www/project", "/home/user"],
    ["/home/use", "/home/user"],
  ])("rejects %j against home %j", (localPath, home) => {
    expect(homeRelativeSuffix(localPath, home)).toBeNull();
  });
});

describe("translateHomePath", () => {
  it("translates the home directory itself and descendants", () => {
    expect(translateHomePath("/home/kg/code/p", "/home/kg", "/Users/kg")).toBe(
      "/Users/kg/code/p",
    );
    expect(translateHomePath("/home/kg", "/home/kg", "/Users/kg")).toBe(
      "/Users/kg",
    );
  });

  it("leaves sibling paths that share the home string prefix unchanged", () => {
    expect(
      translateHomePath("/home/kg-backup/repo", "/home/kg", "/Users/kg"),
    ).toBe("/home/kg-backup/repo");
  });

  it("leaves unrelated paths unchanged", () => {
    expect(translateHomePath("/var/www/p", "/home/kg", "/Users/kg")).toBe(
      "/var/www/p",
    );
  });

  it("maps differently cased Windows home paths to POSIX remote homes", () => {
    expect(
      translateHomePath(
        "C:\\Users\\Dev\\repo\\nested",
        "C:\\Users\\dev",
        "/home/dev",
      ),
    ).toBe("/home/dev/repo/nested");
  });

  it("maps UNC home descendants to either remote path flavor", () => {
    expect(
      translateHomePath(
        "\\\\SERVER\\Share\\User\\repo\\nested",
        "\\\\server\\share\\user",
        "/home/dev",
      ),
    ).toBe("/home/dev/repo/nested");
    expect(
      translateHomePath(
        "\\\\SERVER\\Share\\User\\repo\\nested",
        "\\\\server\\share\\user",
        "D:\\Users\\dev",
      ),
    ).toBe("D:\\Users\\dev\\repo\\nested");
    expect(
      toRemotePath("\\\\SERVER\\Share\\User\\repo", "\\\\server\\share\\user"),
    ).toBe("$HOME/repo");
  });
});
