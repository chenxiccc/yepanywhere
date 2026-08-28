import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectScanner } from "../../src/projects/scanner.js";
import { createFilesRoutes } from "../../src/routes/files.js";
import { createMutableFileCacheMetadata } from "../../src/routes/mutable-file-cache.js";
import { openProjectRelativeFile } from "../../src/utils/projectFileAccess.js";

describe.skipIf(process.platform !== "linux")(
  "descriptor-bound project file access",
  () => {
    let testDir: string;
    let projectRoot: string;

    beforeEach(async () => {
      testDir = await fs.mkdtemp(
        path.join(os.tmpdir(), "project-file-access-test-"),
      );
      projectRoot = path.join(testDir, "project");
      await fs.mkdir(projectRoot);
    });

    afterEach(async () => {
      await fs.rm(testDir, { recursive: true, force: true });
    });

    it("continues through an opened directory when its pathname is replaced", async () => {
      const safeDirectory = path.join(projectRoot, "safe");
      const outsideDirectory = path.join(testDir, "outside");
      await fs.mkdir(safeDirectory);
      await fs.mkdir(outsideDirectory);
      await fs.writeFile(path.join(safeDirectory, "note.txt"), "safe");
      await fs.writeFile(path.join(outsideDirectory, "note.txt"), "outside");

      const opened = await openProjectRelativeFile(
        projectRoot,
        "safe/note.txt",
        {
          beforeComponentOpen: async (relativePath, final) => {
            if (!final || relativePath !== "safe/note.txt") return;
            await fs.rename(safeDirectory, `${safeDirectory}-moved`);
            await fs.symlink(outsideDirectory, safeDirectory, "dir");
          },
        },
      );

      expect(opened).not.toBeNull();
      try {
        await expect(opened!.handle.readFile("utf8")).resolves.toBe("safe");
      } finally {
        await opened?.handle.close();
      }
    });

    it("rejects a final symlink instead of following it", async () => {
      const outsideFile = path.join(testDir, "outside.txt");
      await fs.writeFile(outsideFile, "outside");
      await fs.symlink(outsideFile, path.join(projectRoot, "link.txt"));

      await expect(
        openProjectRelativeFile(projectRoot, "link.txt"),
      ).resolves.toBeNull();
    });

    it("streams the file handle selected before a pathname replacement", async () => {
      const filePath = path.join(projectRoot, "note.txt");
      await fs.writeFile(filePath, "safe");
      const projectId = toUrlProjectId(projectRoot);
      const routes = createFilesRoutes({
        scanner: {
          getProject: async () => ({ path: projectRoot }),
        } as unknown as ProjectScanner,
        strictProjectFileAccess: true,
      });

      const response = await routes.request(
        `/${projectId}/files/raw?path=note.txt`,
      );
      await fs.rename(filePath, `${filePath}-moved`);
      await fs.writeFile(filePath, "replacement");

      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("safe");
    });
  },
);

describe.skipIf(process.platform === "linux")(
  "unsupported descriptor-bound project file access",
  () => {
    it("fails closed when the host cannot traverse directory descriptors", async () => {
      await expect(
        openProjectRelativeFile(
          path.join(os.tmpdir(), "unused-project-root"),
          "note.txt",
        ),
      ).resolves.toBeNull();
    });
  },
);

describe("mutable project file snapshots", () => {
  it("derives validators and bytes from one opened file snapshot", async () => {
    const testDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "project-file-snapshot-test-"),
    );
    const projectRoot = path.join(testDir, "project");
    const filePath = path.join(projectRoot, "note.txt");
    await fs.mkdir(projectRoot);
    await fs.writeFile(filePath, "old");
    const oldMetadata = createMutableFileCacheMetadata(await fs.stat(filePath));
    const projectId = toUrlProjectId(projectRoot);
    const routes = createFilesRoutes({
      scanner: {
        getProject: async () => ({ path: projectRoot }),
      } as unknown as ProjectScanner,
      openFile: async (resolvedPath) => {
        await fs.rename(filePath, `${filePath}.old`);
        await fs.writeFile(filePath, "replacement project bytes");
        return fs.open(resolvedPath, "r");
      },
    });

    try {
      const response = await routes.request(
        `/${projectId}/files/raw?path=note.txt`,
      );
      const replacementMetadata = createMutableFileCacheMetadata(
        await fs.stat(filePath),
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-length")).toBe("25");
      expect(response.headers.get("etag")).toBe(replacementMetadata.etag);
      expect(response.headers.get("etag")).not.toBe(oldMetadata.etag);
      await expect(response.text()).resolves.toBe("replacement project bytes");
    } finally {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });
});
