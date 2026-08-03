import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  UploadManager,
  getProjectAttachmentUploadDir,
  getUploadDir,
  resolveUploadStoragePath,
  sanitizeFilename,
} from "../../src/uploads/manager.js";
import { ProjectStoragePolicy } from "../../src/projects/projectStoragePolicy.js";

const execFileAsync = promisify(execFile);

describe("sanitizeFilename", () => {
  it("generates unique ID for each call", () => {
    const result1 = sanitizeFilename("test.txt");
    const result2 = sanitizeFilename("test.txt");
    expect(result1.id).not.toBe(result2.id);
  });

  it("preserves simple filenames with UUID prefix", () => {
    const { id, sanitized } = sanitizeFilename("document.pdf");
    expect(sanitized).toBe(`${id}_document.pdf`);
  });

  it("strips path components (path traversal prevention)", () => {
    const { id, sanitized } = sanitizeFilename("../../../etc/passwd");
    expect(sanitized).toBe(`${id}_passwd`);
    expect(sanitized).not.toContain("..");
    expect(sanitized).not.toContain("/");
  });

  it("handles Windows path separators", () => {
    const { id, sanitized } = sanitizeFilename("C:\\Users\\test\\file.txt");
    expect(sanitized).toBe(`${id}_file.txt`);
  });

  it("replaces null bytes", () => {
    const { sanitized } = sanitizeFilename("file\x00.txt");
    expect(sanitized).not.toContain("\x00");
  });

  it("handles Windows-invalid characters", () => {
    // Test invalid characters: < > : " | ? * (note: / and \ are path separators)
    const { id, sanitized } = sanitizeFilename('file<>:"|?*.txt');
    expect(sanitized).toBe(`${id}_file_______.txt`); // 7 underscores for 7 invalid chars
  });

  it("handles empty filename", () => {
    const { id, sanitized } = sanitizeFilename("");
    expect(sanitized).toBe(`${id}_unnamed`);
  });

  it("handles dot-only filenames", () => {
    const { id, sanitized } = sanitizeFilename(".");
    expect(sanitized).toBe(`${id}_unnamed`);

    const { id: id2, sanitized: sanitized2 } = sanitizeFilename("..");
    expect(sanitized2).toBe(`${id2}_unnamed`);
  });

  it("truncates very long filenames but preserves extension", () => {
    const longName = `${"a".repeat(300)}.pdf`;
    const { sanitized } = sanitizeFilename(longName);
    // UUID (36) + _ (1) + truncated name (200) + .pdf (4) = 241
    expect(sanitized.length).toBeLessThan(250);
    expect(sanitized).toMatch(/\.pdf$/);
  });

  it("handles filenames with only extension", () => {
    const { id, sanitized } = sanitizeFilename(".gitignore");
    expect(sanitized).toBe(`${id}_.gitignore`);
  });

  it("normalizes the macOS screenshot narrow no-break space (U+202F) before AM/PM", () => {
    // macOS (Ventura+) names screenshots with a U+202F NARROW NO-BREAK SPACE
    // between the time and AM/PM, which looks like a space but breaks path lookups.
    const original = "Screenshot 2026-06-29 at 10.17.29\u202fAM.png";
    const { id, sanitized } = sanitizeFilename(original);
    expect(sanitized).toBe(`${id}_Screenshot 2026-06-29 at 10.17.29 AM.png`);
    expect(sanitized).not.toContain("\u202f");
  });

  it("normalizes other exotic whitespace (NBSP, tabs) to a regular space", () => {
    const { id, sanitized } = sanitizeFilename("a\u00a0b\tc.txt");
    expect(sanitized).toBe(`${id}_a b c.txt`);
  });

  it("strips zero-width/invisible characters", () => {
    const { id, sanitized } = sanitizeFilename("fi\u200ble\ufeff.txt");
    expect(sanitized).toBe(`${id}_file.txt`);
  });
});

describe("getUploadDir", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `upload-test-${randomUUID()}`);
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("creates nested directory structure", async () => {
    const dir = await getUploadDir("encoded-project", "session-123", tempDir);
    expect(dir).toBe(join(tempDir, "encoded-project", "session-123"));

    const stats = await stat(dir);
    expect(stats.isDirectory()).toBe(true);
  });

  it("handles special characters in project path", async () => {
    // base64url encoded paths may have - and _
    const dir = await getUploadDir(
      "abc-def_ghi",
      "session-with-dashes",
      tempDir,
    );
    expect(dir).toContain("abc-def_ghi");
    expect(dir).toContain("session-with-dashes");
  });

  it("rejects traversal-shaped upload path segments", async () => {
    await expect(
      getUploadDir("encoded-project", "..", tempDir),
    ).rejects.toThrow("Invalid upload path segment");
    await expect(
      getUploadDir("encoded-project", "session/child", tempDir),
    ).rejects.toThrow("Invalid upload path segment");
  });
});

describe("resolveUploadStoragePath", () => {
  it("keeps uploads under the configured upload root", () => {
    const root = join(tmpdir(), `upload-root-${randomUUID()}`);

    expect(
      resolveUploadStoragePath(
        root,
        "encoded-project",
        "session-123",
        "00000000-0000-4000-8000-000000000000_file.txt",
      ),
    ).toBe(
      join(
        root,
        "encoded-project",
        "session-123",
        "00000000-0000-4000-8000-000000000000_file.txt",
      ),
    );
    expect(
      resolveUploadStoragePath(root, "encoded-project", "session-123", ".."),
    ).toBeNull();
    expect(
      resolveUploadStoragePath(root, "encoded-project", "session-123/child"),
    ).toBeNull();
  });
});

describe("UploadManager", () => {
  let manager: UploadManager;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `upload-test-${randomUUID()}`);
    manager = new UploadManager({ uploadsDir: tempDir });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  describe("startUpload", () => {
    it("creates upload state with correct initial values", async () => {
      const { uploadId, state } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1024,
        "text/plain",
      );

      expect(uploadId).toBeDefined();
      expect(state.status).toBe("pending");
      expect(state.bytesReceived).toBe(0);
      expect(state.originalName).toBe("test.txt");
      expect(state.expectedSize).toBe(1024);
      expect(state.mimeType).toBe("text/plain");
    });

    it("creates upload directory", async () => {
      await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1024,
        "text/plain",
      );

      const uploadDir = join(tempDir, "encoded-project", "session-123");
      const stats = await stat(uploadDir);
      expect(stats.isDirectory()).toBe(true);
    });
  });

  describe("writeChunk", () => {
    it("writes data and tracks bytes received", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1024,
        "text/plain",
      );

      const chunk = Buffer.from("Hello, World!");
      const bytesReceived = await manager.writeChunk(uploadId, chunk);

      expect(bytesReceived).toBe(13);
      expect(manager.getState(uploadId)?.status).toBe("streaming");
    });

    it("throws for unknown upload ID", async () => {
      await expect(
        manager.writeChunk("nonexistent", Buffer.from("data")),
      ).rejects.toThrow("Upload not found");
    });

    it("accumulates bytes across chunks", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("chunk1"));
      const total = await manager.writeChunk(uploadId, Buffer.from("chunk2"));

      expect(total).toBe(12); // 6 + 6
    });

    it("throws for cancelled upload", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      await manager.cancelUpload(uploadId);

      await expect(
        manager.writeChunk(uploadId, Buffer.from("data")),
      ).rejects.toThrow("Upload not found");
    });
  });

  describe("completeUpload", () => {
    it("returns uploaded file info", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        13,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("Hello, World!"));
      const file = await manager.completeUpload(uploadId);

      expect(file.originalName).toBe("test.txt");
      expect(file.size).toBe(13);
      expect(file.mimeType).toBe("text/plain");
      expect(file.path).toContain(file.name);
    });

    it("file is readable after completion", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        13,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("Hello, World!"));
      const file = await manager.completeUpload(uploadId);

      const content = await readFile(file.path, "utf-8");
      expect(content).toBe("Hello, World!");
    });

    it("handles multiple chunks correctly", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("Hello, "));
      await manager.writeChunk(uploadId, Buffer.from("World!"));
      const file = await manager.completeUpload(uploadId);

      const content = await readFile(file.path, "utf-8");
      expect(content).toBe("Hello, World!");
    });

    it("throws for unknown upload ID", async () => {
      await expect(manager.completeUpload("nonexistent")).rejects.toThrow(
        "Upload not found",
      );
    });

    it("removes upload from tracking after completion", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        13,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("Hello, World!"));
      await manager.completeUpload(uploadId);

      expect(manager.getState(uploadId)).toBeUndefined();
    });
  });

  describe("cancelUpload", () => {
    it("removes partial file", async () => {
      const { uploadId, state } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1000,
        "text/plain",
      );

      await manager.writeChunk(uploadId, Buffer.from("partial data"));
      await manager.cancelUpload(uploadId);

      // File should not exist
      await expect(stat(state.filePath)).rejects.toThrow();
    });

    it("handles cancellation of non-started upload", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        1000,
        "text/plain",
      );

      // Cancel before any chunks written
      await expect(manager.cancelUpload(uploadId)).resolves.not.toThrow();
    });

    it("handles cancellation of nonexistent upload", async () => {
      await expect(manager.cancelUpload("nonexistent")).resolves.not.toThrow();
    });

    it("removes upload from tracking after cancellation", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      await manager.cancelUpload(uploadId);

      expect(manager.getState(uploadId)).toBeUndefined();
    });
  });

  describe("getState", () => {
    it("returns undefined for unknown upload", () => {
      expect(manager.getState("nonexistent")).toBeUndefined();
    });

    it("returns current state for active upload", async () => {
      const { uploadId } = await manager.startUpload(
        "encoded-project",
        "session-123",
        "test.txt",
        100,
        "text/plain",
      );

      const state = manager.getState(uploadId);
      expect(state).toBeDefined();
      expect(state?.originalName).toBe("test.txt");
    });
  });
});

describe("getProjectAttachmentUploadDir", () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), "yep-attach-"));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
  });

  it("writes to app data without creating project state by default", async () => {
    const dataDir = await mkdtemp(join(tmpdir(), "yep-attach-data-"));
    try {
      const storagePolicy = new ProjectStoragePolicy({
        dataDir,
        getMode: () => "app-data",
      });
      const dir = await getProjectAttachmentUploadDir(
        projectDir,
        "sess-1",
        storagePolicy,
      );

      expect(dir).toBe(
        storagePolicy.writePath(projectDir, "attachments", "sess-1"),
      );
      expect((await stat(dir)).isDirectory()).toBe(true);
      await expect(stat(join(projectDir, ".yep"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("creates .yep/attachments/<session> after the project opt-in", async () => {
    await execFileAsync("git", ["-C", projectDir, "init"]);
    const storagePolicy = new ProjectStoragePolicy({
      dataDir: join(projectDir, "unused-data"),
      getMode: () => "project",
    });
    const dir = await getProjectAttachmentUploadDir(
      projectDir,
      "sess-1",
      storagePolicy,
    );
    expect(dir).toBe(join(projectDir, ".yep", "attachments", "sess-1"));
    expect((await stat(dir)).isDirectory()).toBe(true);
    const exclude = await readFile(
      join(projectDir, ".git", "info", "exclude"),
      "utf-8",
    );
    expect(exclude).toContain(".yep/");
  });
});
