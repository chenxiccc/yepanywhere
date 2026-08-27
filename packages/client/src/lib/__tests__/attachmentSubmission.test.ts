import { describe, expect, it } from "vitest";
import { requiresAttachmentOnlyServerUpdate } from "../attachmentSubmission";

describe("requiresAttachmentOnlyServerUpdate", () => {
  it("blocks only attachment-only requests to older servers", () => {
    expect(
      requiresAttachmentOnlyServerUpdate({
        version: { current: "0.7.1" },
        text: "",
        attachmentCount: 1,
      }),
    ).toBe(true);
    expect(
      requiresAttachmentOnlyServerUpdate({
        version: { current: "0.7.2" },
        text: "",
        attachmentCount: 1,
      }),
    ).toBe(false);
    expect(
      requiresAttachmentOnlyServerUpdate({
        version: { current: "0.7.1" },
        text: "caption",
        attachmentCount: 1,
      }),
    ).toBe(false);
    expect(
      requiresAttachmentOnlyServerUpdate({
        version: { current: "0.7.1" },
        text: "",
        attachmentCount: 0,
      }),
    ).toBe(false);
  });
});
