import { toUrlProjectId } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import { normalizePublicShareFilePath } from "../PublicShareContext";

const projectId = toUrlProjectId("/repo");
const attachmentPath =
  "/home/me/.yep-anywhere/projects/0123456789abcdef0123456789abcdef/attachments/session-a/photo.png";

describe("normalizePublicShareFilePath", () => {
  it("keeps mentioned app-data attachment paths as share file links", () => {
    expect(normalizePublicShareFilePath(attachmentPath, projectId)).toEqual({
      path: attachmentPath,
    });
    expect(
      normalizePublicShareFilePath(
        "~/.yep-anywhere/projects/0123456789abcdef0123456789abcdef/attachments/session-a/photo.png",
        projectId,
      ),
    ).toEqual({
      path: "~/.yep-anywhere/projects/0123456789abcdef0123456789abcdef/attachments/session-a/photo.png",
    });
  });

  it("still rejects other absolute paths", () => {
    expect(normalizePublicShareFilePath("/etc/passwd", projectId)).toBeNull();
  });

  it("still rewrites in-project paths to project-relative", () => {
    expect(normalizePublicShareFilePath("/repo/README.md", projectId)).toEqual({
      path: "README.md",
    });
  });
});
