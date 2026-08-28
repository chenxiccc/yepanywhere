import { type UrlProjectId } from "@yep-anywhere/shared";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PublicShareService } from "../../src/services/PublicShareService.js";

const projectId = "cHJvamVjdA" as UrlProjectId;

describe("PublicShareService file grants", () => {
  let service: PublicShareService;
  let testDir: string;

  beforeEach(async () => {
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), "public-file-share-"));
    service = new PublicShareService({ dataDir: testDir });
    await service.initialize();
  });

  afterEach(async () => {
    await fs.rm(testDir, { recursive: true, force: true });
  });

  it("persists and resolves a live file grant independently from sessions", async () => {
    const created = await service.createFileShare({
      projectId,
      path: "docs/guide.md",
      title: "Guide",
      buildPublicUrl: (secret) =>
        `https://viewer.example/share/${secret}/file?path=docs%2Fguide.md`,
    });

    expect(created.secretBits).toBe(128);
    expect(service.getRecordBySecret(created.secret)).toBeNull();
    expect(service.getFileRecordBySecret(created.secret)).toMatchObject({
      projectId,
      path: "docs/guide.md",
      title: "Guide",
    });
    expect(service.getPublicFileShares(projectId, "docs/guide.md")).toEqual([
      expect.objectContaining({
        shareId: created.record.shareId,
        url: created.record.url,
      }),
    ]);

    const persisted = await fs.readFile(
      path.join(testDir, "public-shares", "file-grants.json"),
      "utf8",
    );
    expect(persisted).toContain(created.record.url);
    expect(persisted).toContain("secretHash");

    const reopened = new PublicShareService({ dataDir: testDir });
    await reopened.initialize();
    expect(reopened.getFileRecordBySecret(created.secret)).toMatchObject({
      shareId: created.record.shareId,
      path: "docs/guide.md",
    });
  });

  it("revokes one file grant without affecting another", async () => {
    const first = await service.createFileShare({
      projectId,
      path: "docs/guide.md",
      buildPublicUrl: (secret) => `https://viewer.example/share/${secret}/file`,
    });
    const second = await service.createFileShare({
      projectId,
      path: "docs/guide.md",
      buildPublicUrl: (secret) => `https://viewer.example/share/${secret}/file`,
    });

    await expect(service.revokeFileShare(first.record.shareId)).resolves.toBe(
      true,
    );
    expect(service.getFileRecordBySecret(first.secret)).toBeNull();
    expect(service.getFileRecordBySecret(second.secret)).not.toBeNull();
  });

  it("includes file grants in explicit global revocation", async () => {
    const created = await service.createFileShare({
      projectId,
      path: "docs/guide.md",
      buildPublicUrl: (secret) => `https://viewer.example/share/${secret}/file`,
    });

    await expect(service.revokeAllShares()).resolves.toBe(1);
    expect(service.getFileRecordBySecret(created.secret)).toBeNull();
  });

  it("does not resurrect file grants after the global kill switch", async () => {
    const created = await service.createFileShare({
      projectId,
      path: "docs/guide.md",
      buildPublicUrl: (secret) => `https://viewer.example/share/${secret}/file`,
    });

    await expect(service.disableAndRevoke()).resolves.toBe(1);
    expect(service.getReadiness().state).toBe("disabled");
    await service.enable();
    expect(service.getReadiness().state).toBe("ready");
    expect(service.getFileRecordBySecret(created.secret)).toBeNull();

    const reopened = new PublicShareService({ dataDir: testDir });
    await reopened.initialize();
    expect(reopened.getPublicFileShares(projectId, "docs/guide.md")).toEqual(
      [],
    );
  });

  it("rejects non-normalized persisted file paths", async () => {
    const grantsPath = path.join(testDir, "public-shares", "file-grants.json");
    await fs.writeFile(
      grantsPath,
      JSON.stringify({
        version: 1,
        grants: [
          {
            version: 1,
            shareId: "AAAAAAAAAAAAAAAA",
            secretHash: "A".repeat(86),
            url: "https://viewer.example/share/secret/file",
            projectId,
            path: "../secret.txt",
            title: null,
            createdAt: "2026-08-28T00:00:00.000Z",
            updatedAt: "2026-08-28T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );

    const reopened = new PublicShareService({ dataDir: testDir });
    await expect(reopened.initialize()).rejects.toThrow(
      "Public file share grant file is invalid",
    );
    expect(reopened.getReadiness().state).toBe("failed");
  });
});
