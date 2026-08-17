import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_FILE_ACCESS,
  getAllowedFilePaths,
  getFileAccessInfo,
  initFileAccess,
  isFileAccessEnvPinned,
  normalizeFileAccess,
  shouldIncludeProjects,
  updateFileAccess,
} from "../../src/middleware/file-access.js";

describe("file-access policy state", () => {
  beforeEach(() => {
    initFileAccess({
      uploadsDir: "/data/uploads",
      homeDir: "/home/me",
      tempPaths: ["/tmp"],
      envPaths: null,
      appDataProjectsDir: "/data/projects",
    });
    updateFileAccess(undefined);
  });

  it("defaults to projects + uploads + temp, no home/custom", () => {
    expect(getAllowedFilePaths().sort()).toEqual([
      "/data/projects",
      "/data/uploads",
      "/tmp",
    ]);
    expect(shouldIncludeProjects()).toBe(true);
    expect(isFileAccessEnvPinned()).toBe(false);
  });

  it("adds home and custom when enabled and expands ~", () => {
    updateFileAccess({
      projects: true,
      uploads: false,
      temp: false,
      home: true,
      custom: ["~/notes", "/mnt/data", "   "],
    });
    const set = getAllowedFilePaths();
    expect(set).toContain("/home/me");
    expect(set).toContain("/home/me/notes");
    expect(set).toContain("/mnt/data");
    expect(set).not.toContain("/data/uploads");
    expect(set).not.toContain("/tmp");
    expect(set).toContain("/data/projects");
  });

  it("expands ~ using the home path separator style", () => {
    initFileAccess({
      uploadsDir: "C:\\data\\uploads",
      homeDir: "C:\\Users\\me",
      tempPaths: ["C:\\Temp"],
      envPaths: null,
    });
    updateFileAccess({
      projects: true,
      uploads: false,
      temp: false,
      home: true,
      custom: ["~/notes", "~\\logs"],
    });

    expect(getAllowedFilePaths()).toEqual([
      "C:\\Users\\me",
      "C:\\Users\\me\\notes",
      "C:\\Users\\me\\logs",
    ]);
  });

  it("keeps app-data project attachments readable when uploads are off", () => {
    updateFileAccess({
      projects: true,
      uploads: false,
      temp: false,
      home: false,
      custom: [],
    });
    expect(getAllowedFilePaths()).toEqual(["/data/projects"]);
  });

  it("gates scanned projects off", () => {
    updateFileAccess({ ...DEFAULT_FILE_ACCESS, projects: false });
    expect(shouldIncludeProjects()).toBe(false);
  });

  it("env pin replaces the editable set but keeps uploads and projects", () => {
    initFileAccess({
      uploadsDir: "/data/uploads",
      homeDir: "/home/me",
      tempPaths: ["/tmp"],
      envPaths: ["/srv/pinned"],
      appDataProjectsDir: "/data/projects",
    });
    // These settings should be ignored while env-pinned.
    updateFileAccess({
      projects: false,
      uploads: false,
      temp: false,
      home: true,
      custom: ["/ignored"],
    });
    expect(isFileAccessEnvPinned()).toBe(true);
    expect(getAllowedFilePaths().sort()).toEqual([
      "/data/projects",
      "/data/uploads",
      "/srv/pinned",
    ]);
    expect(shouldIncludeProjects()).toBe(true);
    expect(getFileAccessInfo().envPaths).toEqual(["/srv/pinned"]);
  });

  it("normalizes partial/untrusted settings", () => {
    expect(normalizeFileAccess(undefined)).toEqual(DEFAULT_FILE_ACCESS);
    expect(normalizeFileAccess({ custom: [" a ", "", "b"] }).custom).toEqual([
      "a",
      "b",
    ]);
    // Missing booleans fall back to secure defaults.
    expect(normalizeFileAccess({ home: true })).toEqual({
      projects: true,
      uploads: true,
      temp: true,
      home: true,
      custom: [],
    });
  });
});
