import { describe, expect, it } from "vitest";
import {
  HISTORY_SEARCH_PAGE_MATCH_LIMIT,
  searchSessionHistoryPage,
} from "../../sessionHistorySearch";
import type { Message } from "../../../types";

function userMessage(id: string, content: string): Message {
  return {
    type: "user",
    uuid: id,
    message: { role: "user", content },
  };
}

describe("session history search", () => {
  it("returns bounded excerpts instead of retaining searchable page text", () => {
    const messages = Array.from(
      { length: HISTORY_SEARCH_PAGE_MATCH_LIMIT + 1 },
      (_, index) => userMessage(`user-${index}`, `shared needle ${index}`),
    );

    const result = searchSessionHistoryPage({
      caseSensitive: false,
      conversationViewEnabled: false,
      messages,
      query: "needle",
      scope: "user",
      thinkingItemsVisible: true,
    });

    expect(result.matchesTruncated).toBe(true);
    expect(result.matches).toHaveLength(HISTORY_SEARCH_PAGE_MATCH_LIMIT);
    expect(result.matches[0]?.id).toBe("user-1");
    expect(result.matches.at(-1)?.id).toBe(
      `user-${HISTORY_SEARCH_PAGE_MATCH_LIMIT}`,
    );
    expect(result.matches[0]).toEqual({
      id: "user-1",
      preview: "shared needle 1",
      timestampMs: null,
    });
  });

  it("uses the full-session projection for tool input", () => {
    const messages: Message[] = [
      userMessage("user-1", "inspect the project"),
      {
        type: "assistant",
        uuid: "assistant-1",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "grep-1",
              name: "Grep",
              input: { pattern: "BuriedToolNeedle" },
            },
          ],
        },
      },
    ];

    const result = searchSessionHistoryPage({
      caseSensitive: false,
      conversationViewEnabled: false,
      messages,
      query: "buriedtoolneedle",
      scope: "full",
      thinkingItemsVisible: true,
    });

    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]?.id).toContain("grep-1");
    expect(result.matches[0]?.preview).toContain("BuriedToolNeedle");
  });
});
