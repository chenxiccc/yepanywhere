// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  asClientSummarySourceKey,
  createClientSummaryHostSourceKey,
  LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
} from "../clientSummaryStore";
import {
  createSessionDraftStorageKey,
  removeSessionDraft,
  saveSessionDraft,
  scanSessionDraftIds,
} from "../sessionDraftStorage";
import { subscribeDraftPresenceChanges } from "../draftPresenceEvents";

function readStoredText(key: string): string | null {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  return (JSON.parse(raw) as { text?: string }).text ?? null;
}

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("sessionDraftStorage", () => {
  it("keeps local drafts on the legacy key and backfills the index", () => {
    saveSessionDraft(
      {
        sourceKey: LOCAL_CLIENT_SUMMARY_SOURCE_KEY,
        sessionId: "session-a",
      },
      "draft text",
    );

    expect(readStoredText("draft-message-session-a")).toBe("draft text");
    expect([...scanSessionDraftIds(LOCAL_CLIENT_SUMMARY_SOURCE_KEY)]).toEqual([
      "session-a",
    ]);
    expect(localStorage.getItem("draft-presence-message:local:session-a")).toBe(
      "1",
    );
  });

  it("discovers remote drafts from only the source index", () => {
    const macbook = createClientSummaryHostSourceKey("macbook");
    const winnative = createClientSummaryHostSourceKey("winnative");

    saveSessionDraft({ sourceKey: macbook, sessionId: "mac-session" }, "mac");
    saveSessionDraft({ sourceKey: winnative, sessionId: "win-session" }, "win");
    localStorage.setItem("draft-message-legacy-session", "legacy");

    expect([...scanSessionDraftIds(macbook)]).toEqual(["mac-session"]);
    expect([...scanSessionDraftIds(winnative)]).toEqual(["win-session"]);
    expect([...scanSessionDraftIds(LOCAL_CLIENT_SUMMARY_SOURCE_KEY)]).toEqual([
      "legacy-session",
    ]);
  });

  it("removes empty drafts from the index", () => {
    const sourceKey = asClientSummarySourceKey("direct:ws://example/ws");
    const reference = { sourceKey, sessionId: "session-a" };

    saveSessionDraft(reference, "draft text");
    saveSessionDraft(reference, "");

    expect([...scanSessionDraftIds(sourceKey)]).toEqual([]);
    expect(
      localStorage.getItem(
        "draft-index-message:direct%3Aws%3A%2F%2Fexample%2Fws",
      ),
    ).toBe(null);
  });

  it("writes the index and publishes only on presence transitions", () => {
    const sourceKey = asClientSummarySourceKey("host:macbook");
    const reference = { sourceKey, sessionId: "session-a" };
    const listener = vi.fn();
    const unsubscribe = subscribeDraftPresenceChanges(listener);
    const setItem = vi.spyOn(localStorage, "setItem");

    saveSessionDraft(reference, "a");

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith({
      storageKey: "draft-message:host%3Amacbook:session-a",
      hasContent: true,
      sessionDraft: reference,
    });

    setItem.mockClear();
    saveSessionDraft(reference, "ab");

    expect(setItem.mock.calls.map(([key]) => key)).toEqual([
      "draft-message:host%3Amacbook:session-a",
    ]);
    expect(listener).toHaveBeenCalledTimes(1);

    removeSessionDraft(reference);

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith({
      storageKey: "draft-message:host%3Amacbook:session-a",
      hasContent: false,
      sessionDraft: reference,
    });
    unsubscribe();
  });

  it("repairs a failed presence-index transition on the next edit", () => {
    const sourceKey = asClientSummarySourceKey("host:macbook");
    const reference = { sourceKey, sessionId: "session-a" };
    const originalSetItem = localStorage.setItem.bind(localStorage);
    let writes = 0;
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      writes += 1;
      if (writes === 2) {
        throw new DOMException("quota", "QuotaExceededError");
      }
      originalSetItem(key, value);
    });

    saveSessionDraft(reference, "a");
    saveSessionDraft(reference, "ab");

    expect(readStoredText(createSessionDraftStorageKey(reference))).toBe("ab");
    expect([...scanSessionDraftIds(sourceKey)]).toEqual(["session-a"]);
  });

  it("indexes concurrent sessions with independent presence markers", () => {
    const sourceKey = asClientSummarySourceKey("host:macbook");

    saveSessionDraft({ sourceKey, sessionId: "session-a" }, "a");
    saveSessionDraft({ sourceKey, sessionId: "session-b" }, "b");

    expect(
      localStorage.getItem("draft-presence-message:host%3Amacbook:session-a"),
    ).toBe("1");
    expect(
      localStorage.getItem("draft-presence-message:host%3Amacbook:session-b"),
    ).toBe("1");
    expect([...scanSessionDraftIds(sourceKey)].sort()).toEqual([
      "session-a",
      "session-b",
    ]);
  });

  it("keeps attachment-only envelopes in the index", () => {
    const sourceKey = asClientSummarySourceKey("direct:ws://example/ws");
    const key = createSessionDraftStorageKey({
      sourceKey,
      sessionId: "session-a",
    });
    localStorage.setItem(
      key,
      JSON.stringify({
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
      }),
    );
    localStorage.setItem(
      "draft-index-message:direct%3Aws%3A%2F%2Fexample%2Fws",
      '["session-a"]',
    );

    expect([...scanSessionDraftIds(sourceKey)]).toEqual(["session-a"]);
  });

  it("builds encoded remote body keys", () => {
    const sourceKey = asClientSummarySourceKey("direct:ws://example/ws");

    expect(
      createSessionDraftStorageKey({ sourceKey, sessionId: "session/a" }),
    ).toBe("draft-message:direct%3Aws%3A%2F%2Fexample%2Fws:session%2Fa");
  });
});
