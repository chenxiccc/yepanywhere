import { describe, expect, it } from "vitest";
import {
  draftStorageValueForAttachments,
  draftStorageValueForText,
  hasDraftContentValue,
  readDraftAttachmentStateValue,
  readDraftEnvelopeValue,
  readDraftTextValue,
} from "../draftEnvelope";

const attachmentEnvelope = JSON.stringify({
  version: 1,
  text: "",
  attachments: {
    batchId: "batch-a",
    updatedAt: "2026-06-28T00:00:00.000Z",
    refs: [
      {
        id: "file-a",
        batchId: "batch-a",
        originalName: "screenshot.png",
        name: "uuid_screenshot.png",
        size: 123,
        mimeType: "image/png",
        createdAt: "2026-06-28T00:00:00.000Z",
        updatedAt: "2026-06-28T00:00:00.000Z",
      },
    ],
  },
});

describe("draftEnvelope", () => {
  it("reads legacy raw strings as text drafts", () => {
    expect(readDraftTextValue("legacy text")).toBe("legacy text");
    expect(hasDraftContentValue("legacy text")).toBe(true);
  });

  it("ignores broken draft envelopes", () => {
    const result = readDraftEnvelopeValue('{"version":1,');

    expect(result.envelope).toBe(null);
    expect(result.invalidEnvelope).toBe(true);
    expect(hasDraftContentValue('{"version":1,')).toBe(false);
  });

  it("treats unsupported envelope versions as invalid", () => {
    const result = readDraftEnvelopeValue(
      JSON.stringify({ version: 99, text: "future" }),
    );

    expect(result.envelope).toBe(null);
    expect(result.invalidEnvelope).toBe(true);
  });

  it("keeps attachment-only envelopes as draft content", () => {
    expect(readDraftTextValue(attachmentEnvelope)).toBe("");
    expect(hasDraftContentValue(attachmentEnvelope)).toBe(true);
  });

  it("preserves existing attachments when writing draft text", () => {
    const nextRaw = draftStorageValueForText("with text", attachmentEnvelope);
    const next = readDraftEnvelopeValue(nextRaw).envelope;

    expect(next?.text).toBe("with text");
    expect(next?.attachments?.refs).toHaveLength(1);
  });

  it("preserves existing text when writing draft attachments", () => {
    const withText = draftStorageValueForText("draft text");
    const attachments =
      readDraftEnvelopeValue(attachmentEnvelope).envelope?.attachments;
    const nextRaw = draftStorageValueForAttachments(attachments, withText);
    const next = readDraftEnvelopeValue(nextRaw).envelope;

    expect(next?.text).toBe("draft text");
    expect(next?.attachments?.refs).toHaveLength(1);
    expect(readDraftAttachmentStateValue(nextRaw)?.batchId).toBe("batch-a");
  });

  it("removes attachment state while preserving text", () => {
    const withText = draftStorageValueForText("draft text", attachmentEnvelope);
    const nextRaw = draftStorageValueForAttachments(null, withText);
    const next = readDraftEnvelopeValue(nextRaw).envelope;

    expect(next?.text).toBe("draft text");
    expect(next?.attachments).toBeUndefined();
  });

  it("removes empty text-only drafts", () => {
    expect(draftStorageValueForText("")).toBe(null);
  });
});
