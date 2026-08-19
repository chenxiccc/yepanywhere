import { describe, expect, it } from "vitest";
import {
  CONVERSATION_THINKING_AUTO_HIDE_MS,
  conversationThinkingAutoHideDelayMs,
} from "../thinkingPreviewAutoHide";

describe("conversationThinkingAutoHideDelayMs", () => {
  it("keeps thinking visible while the turn is active", () => {
    expect(
      conversationThinkingAutoHideDelayMs({
        active: true,
        hasFollowingConversationText: true,
        endedAtMs: 1_000,
        nowMs: 1_000,
      }),
    ).toBeNull();
  });

  it("keeps thinking visible when no conversation text followed it", () => {
    expect(
      conversationThinkingAutoHideDelayMs({
        active: false,
        hasFollowingConversationText: false,
        endedAtMs: 1_000,
        nowMs: 20_000,
      }),
    ).toBeNull();
  });

  it("waits the remaining time after a just-completed turn", () => {
    expect(
      conversationThinkingAutoHideDelayMs({
        active: false,
        hasFollowingConversationText: true,
        endedAtMs: 10_000,
        nowMs: 11_000,
      }),
    ).toBe(CONVERSATION_THINKING_AUTO_HIDE_MS - 1_000);
  });

  it("hides immediately for a turn that completed past the delay", () => {
    expect(
      conversationThinkingAutoHideDelayMs({
        active: false,
        hasFollowingConversationText: true,
        endedAtMs: 1_000,
        nowMs: 1_000 + CONVERSATION_THINKING_AUTO_HIDE_MS,
      }),
    ).toBe(0);
  });
});
