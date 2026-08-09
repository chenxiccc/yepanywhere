import { describe, expect, it } from "vitest";
import {
  getAbsoluteFilePath,
  getPathBasename,
  getProjectRelativePath,
  makeDisplayPath,
  shortenPath,
  splitDisplayPath,
} from "../text";

describe("path display helpers", () => {
  it("makes POSIX project-local absolute paths project-relative", () => {
    expect(
      makeDisplayPath(
        "/Users/user/Documents/code/playbox/docs/tactical/note.md",
        "/Users/user/Documents/code/playbox",
      ),
    ).toBe("docs/tactical/note.md");
  });

  it("makes Windows project-local absolute paths project-relative", () => {
    expect(
      makeDisplayPath(
        "C:\\Users\\user\\Documents\\code\\playbox\\docs\\tactical\\note.md",
        "C:\\Users\\user\\Documents\\code\\playbox",
      ),
    ).toBe("docs/tactical/note.md");
  });

  it("compares Windows drive paths case-insensitively", () => {
    expect(
      getProjectRelativePath(
        "c:\\Users\\User\\Documents\\Code\\Playbox\\src\\App.tsx",
        "C:/Users/user/Documents/code/playbox",
      ),
    ).toBe("src/App.tsx");
  });

  it("normalizes browser-style Windows drive paths", () => {
    expect(
      getProjectRelativePath(
        "/C:/Users/user/Documents/code/playbox/src/App.tsx",
        "C:\\Users\\user\\Documents\\code\\playbox",
      ),
    ).toBe("src/App.tsx");
  });

  it("shortens home paths without changing unrelated absolute paths", () => {
    expect(shortenPath("C:\\Users\\user\\Downloads\\trace.log")).toBe(
      "~/Downloads/trace.log",
    );
    expect(shortenPath("D:\\work\\external\\trace.log")).toBe(
      "D:\\work\\external\\trace.log",
    );
  });

  it("resolves project-relative paths without rewriting absolute paths", () => {
    expect(getAbsoluteFilePath("docs/note.md", "/workspace/project")).toBe(
      "/workspace/project/docs/note.md",
    );
    expect(getAbsoluteFilePath("docs\\note.md", "C:\\workspace\\project")).toBe(
      "C:/workspace/project/docs/note.md",
    );
    expect(getAbsoluteFilePath("/tmp/note.md", "/workspace/project")).toBe(
      "/tmp/note.md",
    );
    expect(getAbsoluteFilePath("docs/note.md", null)).toBeNull();
  });

  it("handles basename and display splitting for both slash styles", () => {
    expect(splitDisplayPath("src/main.rs")).toEqual({
      dir: "src/",
      name: "main.rs",
    });
    expect(getPathBasename("C:\\repo\\src\\App.tsx")).toBe("App.tsx");
    expect(splitDisplayPath("C:\\repo\\src\\App.tsx")).toEqual({
      dir: "C:\\repo\\src\\",
      name: "App.tsx",
    });
  });
});
