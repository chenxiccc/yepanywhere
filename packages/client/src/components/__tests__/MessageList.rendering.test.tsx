// @vitest-environment jsdom

import { Profiler } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { buildCorrectionText } from "../../lib/correctionText";
import { UI_KEYS } from "../../lib/storageKeys";
import {
  assistantMessage,
  codexThinkingMessage,
  installMessageListTestEnvironment,
  userMessage,
} from "./MessageList.test-support";
import { createComposerDraftSignal } from "../../lib/composerDraftSignal";
import { MessageList } from "../MessageList";

installMessageListTestEnvironment();

describe("MessageList rendering", () => {
  it("does not commit the transcript subtree for ordinary draft changes", () => {
    const composerDraftSignal = createComposerDraftSignal();
    const onRender = vi.fn();

    render(
      <Profiler id="transcript" onRender={onRender}>
        <MessageList
          messages={[
            userMessage("user-1", "inspect this"),
            assistantMessage("assistant-1", "done"),
          ]}
          composerDraftSignal={composerDraftSignal}
        />
      </Profiler>,
    );
    const initialCommitCount = onRender.mock.calls.length;

    act(() => {
      composerDraftSignal.publishDraftChange("a", {
        mayAffectQuoteAnchors: false,
      });
      composerDraftSignal.publishDraftChange("ab", {
        mayAffectQuoteAnchors: false,
      });
      composerDraftSignal.publishDraftChange("", {
        mayAffectQuoteAnchors: true,
      });
    });

    expect(onRender).toHaveBeenCalledTimes(initialCommitCount);
  });

  it("condenses and restores routine activity in Conversation view", () => {
    window.localStorage.setItem(UI_KEYS.conversationView, "true");
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "inspect this", "2026-07-28T07:00:00.000Z"),
          codexThinkingMessage(
            "thinking-1",
            "private planning",
            "2026-07-28T07:00:01.000Z",
          ),
          assistantMessage(
            "assistant-1",
            "Visible answer",
            "2026-07-28T07:00:02.000Z",
          ),
        ]}
      />,
    );

    expect(screen.getByText("Visible answer")).toBeTruthy();
    expect(screen.queryByText("private planning")).toBeNull();
    const summary = container.querySelector(
      ".conversation-activity-summary",
    ) as HTMLButtonElement | null;
    expect(summary).toBeTruthy();
    expect(summary?.textContent).toContain("1 activity hidden");

    fireEvent.click(summary as HTMLButtonElement);

    expect(screen.getByText("private planning")).toBeTruthy();
    expect(
      container
        .querySelector(".conversation-activity-summary")
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });

  it("offers correction only for the latest real user message", () => {
    const onCorrect = vi.fn();

    render(
      <MessageList
        messages={[
          userMessage("user-1", "first request"),
          assistantMessage("assistant-1", "response"),
          userMessage("user-2", "second request"),
        ]}
        onCorrectLatestUserMessage={onCorrect}
      />,
    );

    const buttons = screen.getAllByRole("button", {
      name: "Edit latest message",
    });
    expect(buttons).toHaveLength(1);
    expect((buttons[0] as HTMLElement).textContent).toContain("Edit");

    fireEvent.click(buttons[0] as HTMLElement);

    expect(onCorrect).toHaveBeenCalledWith("user-2", "second request");
  });

  it("renders compact summaries as one collapsed compact notification", () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            type: "system",
            uuid: "compact-boundary",
            subtype: "compact_boundary",
            content: "Conversation compacted",
            compactMetadata: { trigger: "manual", preTokens: 123 },
          },
          {
            type: "user",
            uuid: "compact-summary",
            message: {
              role: "user",
              content:
                "This session is being continued from a previous conversation that ran out of context.\n\nSummary:\n- hidden detail",
            },
            isCompactSummary: true,
            isVisibleInTranscriptOnly: true,
          },
          {
            type: "user",
            uuid: "compact-stdout",
            message: {
              role: "user",
              content:
                "<local-command-stdout>Compacted </local-command-stdout>",
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("Conversation compacted")).toBeTruthy();
    expect(screen.queryByText("/compact")).toBeNull();
    expect(screen.queryByText("Compacted")).toBeNull();

    const compactDetails = container.querySelector(
      "details.system-message-compact-boundary",
    ) as HTMLDetailsElement | null;
    expect(compactDetails).toBeTruthy();
    expect(compactDetails?.open).toBe(false);

    const summary = compactDetails?.querySelector("summary");
    expect(summary).toBeTruthy();
    fireEvent.click(summary as HTMLElement);
    expect(compactDetails?.open).toBe(true);
    expect(screen.getByText(/hidden detail/)).toBeTruthy();
    expect(screen.getByText(/compactMetadata/)).toBeTruthy();
  });

  it("does not restart progressive loading after the session is revealed", async () => {
    vi.useFakeTimers();
    const messages = [
      userMessage("user-1", "first request"),
      assistantMessage("assistant-1", "first response"),
    ];
    const composerDraftSignal = createComposerDraftSignal();
    const { container, rerender } = render(
      <MessageList
        messages={messages}
        composerDraftSignal={composerDraftSignal}
        progressiveRenderEnabled
        progressiveRenderKey="session-1"
      />,
    );

    expect(container.querySelector(".session-render-progress")).not.toBeNull();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(container.querySelector(".session-render-progress")).toBeNull();

    await act(async () => {
      composerDraftSignal.publishDraftChange("typing should stay local", {
        mayAffectQuoteAnchors: false,
      });
    });

    expect(container.querySelector(".session-render-progress")).toBeNull();

    await act(async () => {
      rerender(
        <MessageList
          messages={[...messages, userMessage("user-2", "second request")]}
          composerDraftSignal={composerDraftSignal}
          progressiveRenderEnabled
          progressiveRenderKey="session-1"
        />,
      );
    });

    expect(container.querySelector(".session-render-progress")).toBeNull();

    await act(async () => {
      rerender(
        <MessageList
          messages={messages}
          progressiveRenderEnabled
          progressiveRenderKey="session-2"
        />,
      );
    });

    expect(container.querySelector(".session-render-progress")).not.toBeNull();
  });

  it("can hide progressive details while hydrating", () => {
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first request"),
          assistantMessage("assistant-1", "first response"),
        ]}
        progressiveRenderEnabled
        progressiveRenderKey="session-1"
        progressiveRenderStatusVisible={false}
      />,
    );

    expect(container.querySelector(".session-render-progress")).not.toBeNull();
    expect(screen.getByText("Loading session...")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/Rendering transcript/)).toBeNull();
  });

  it("does not publish scroll snapshots while progressively hydrating", () => {
    vi.useFakeTimers();
    const onScrollSnapshotChange = vi.fn();
    const { container, unmount } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first request"),
          assistantMessage("assistant-1", "first response"),
        ]}
        progressiveRenderEnabled
        progressiveRenderKey="snapshot-gate-active"
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 120,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });

    fireEvent.scroll(container);
    expect(onScrollSnapshotChange).not.toHaveBeenCalled();

    unmount();
    expect(onScrollSnapshotChange).not.toHaveBeenCalled();
  });

  it("publishes a settled scroll snapshot after progressive hydration", async () => {
    vi.useFakeTimers();
    const onScrollSnapshotChange = vi.fn();
    const assistantTimestamp = "2026-04-26T12:01:00.000Z";
    const { container } = render(
      <MessageList
        messages={[
          userMessage("user-1", "first request", "2026-04-26T12:00:00.000Z"),
          assistantMessage("assistant-1", "first response", assistantTimestamp),
        ]}
        progressiveRenderEnabled
        progressiveRenderKey="snapshot-gate-complete"
        onScrollSnapshotChange={onScrollSnapshotChange}
      />,
    );

    Object.defineProperty(container, "scrollTop", {
      configurable: true,
      value: 120,
      writable: true,
    });
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(container, "clientHeight", {
      configurable: true,
      value: 300,
    });
    const rectFor = (top: number, height: number): DOMRect =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 400,
        width: 400,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect;
    container.getBoundingClientRect = () => rectFor(0, 300);
    const user1 = container.querySelector<HTMLElement>(
      '[data-render-id="user-1"]',
    );
    const assistant1 = container.querySelector<HTMLElement>(
      '[data-render-id="assistant-1"]',
    );
    expect(user1).toBeTruthy();
    expect(assistant1).toBeTruthy();
    (user1 as HTMLElement).getBoundingClientRect = () => rectFor(40, 40);
    (assistant1 as HTMLElement).getBoundingClientRect = () => rectFor(420, 80);

    expect(onScrollSnapshotChange).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(250);
    });

    expect(onScrollSnapshotChange).toHaveBeenCalledTimes(1);
    expect(onScrollSnapshotChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        atBottom: true,
        scrollTop: 700,
        anchor: expect.objectContaining({
          id: "user-1",
          topOffset: 40,
          nextId: "assistant-1",
          timestampMs: new Date("2026-04-26T12:00:00.000Z").getTime(),
        }),
      }),
    );
  });

  it("renders slash-command skill text as collapsed command details", () => {
    const { container } = render(
      <MessageList
        messages={[
          {
            type: "user",
            uuid: "command",
            promptId: "prompt-1",
            message: {
              role: "user",
              content:
                "<command-message>harsh-review</command-message>\n" +
                "<command-name>/harsh-review</command-name>\n" +
                "<command-args>last 10 commits</command-args>",
            },
          },
          {
            type: "user",
            uuid: "skill-body",
            isMeta: true,
            parentUuid: "command",
            promptId: "prompt-1",
            message: {
              role: "user",
              content: [
                {
                  type: "text",
                  text:
                    "Base directory for this skill: /home/graehl/.claude/skills/harsh-review\n\n" +
                    "# Harsh review\n\nFirst classify each changed artifact.",
                },
              ],
            },
          },
        ]}
      />,
    );

    expect(screen.getByText("/harsh-review last 10 commits")).toBeTruthy();
    expect(
      container.querySelector("[data-render-type='user_prompt']"),
    ).toBeNull();

    const commandDetails = container.querySelector(
      "details.system-message-local-command",
    ) as HTMLDetailsElement | null;
    expect(commandDetails).toBeTruthy();
    expect(commandDetails?.open).toBe(false);

    const summary = commandDetails?.querySelector("summary");
    expect(summary).toBeTruthy();
    fireEvent.click(summary as HTMLElement);
    expect(commandDetails?.open).toBe(true);
    expect(
      screen.getByText(/First classify each changed artifact/),
    ).toBeTruthy();
  });

  it("passes display text without uploaded-file metadata to correction", () => {
    const onCorrect = vi.fn();

    render(
      <MessageList
        messages={[
          userMessage(
            "user-1",
            "fix typo\n\nUser uploaded files:\n- notes.txt (12 B, text/plain): /uploads/notes.txt",
          ),
        ]}
        onCorrectLatestUserMessage={onCorrect}
      />,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Edit latest message" }),
    );

    expect(onCorrect).toHaveBeenCalledWith("user-1", "fix typo");
  });

  it("renders correction messages with corrected text as the primary content", () => {
    render(
      <MessageList
        messages={[
          userMessage(
            "user-1",
            buildCorrectionText("(testing)", "(test correction)") ?? "",
          ),
        ]}
      />,
    );

    expect(screen.getByText("Correction")).toBeTruthy();
    expect(screen.getByText("(test correction)")).toBeTruthy();
    expect(
      screen.getByText('Change: replace "testing" with "test correction".'),
    ).toBeTruthy();
  });
});
