import { describe, expect, it } from "vitest";
import { toUrlProjectId } from "@yep-anywhere/shared";
import {
  formatAttachmentName,
  getAttachmentIdFromPersistedPath,
  getPersistedAttachmentUploadUrl,
} from "../AttachmentChip";

describe("formatAttachmentName", () => {
  it("keeps the last separator when the next word would overshoot the window", () => {
    expect(formatAttachmentName("disconnect-pull-plate-condition.jpg")).toBe(
      "disconnect-pull-plate...",
    );
  });

  it("allows a partial word only when there are no separators to cut on", () => {
    expect(
      formatAttachmentName("averylongfilenamewithnospacesorbreaks.txt"),
    ).toBe("averylongfilenamewithnos...");
  });
});

describe("getPersistedAttachmentUploadUrl", () => {
  const filename = "12345678-1234-1234-1234-123456789abc_image.png";

  it("uses the physical session directory from a Windows app-data path", () => {
    const projectId = toUrlProjectId("C:\\work\\project");

    expect(
      getPersistedAttachmentUploadUrl(
        `C:\\ya-data\\projects\\key\\attachments\\physical-session\\${filename}`,
        projectId,
      ),
    ).toBe(
      `/api/projects/${encodeURIComponent(projectId)}/sessions/physical-session/upload/${filename}`,
    );
  });

  it("reads the attachment id from a persisted filename", () => {
    expect(
      getAttachmentIdFromPersistedPath(
        `/home/graehl/.yep-anywhere/projects/abc/attachments/session/${filename}`,
      ),
    ).toBe("12345678-1234-1234-1234-123456789abc");
  });

  it("preserves a Windows project root for legacy path-based routing", () => {
    const projectPath = "C:\\work\\project";

    expect(
      getPersistedAttachmentUploadUrl(
        `${projectPath}\\.yep\\attachments\\physical-session\\${filename}`,
      ),
    ).toBe(
      `/api/projects/${toUrlProjectId(projectPath)}/sessions/physical-session/upload/${filename}`,
    );
  });
});
