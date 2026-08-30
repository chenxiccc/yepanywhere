import type { CodexSessionEntry } from "@yep-anywhere/shared";
import { describe, expect, it } from "vitest";
import {
  buildCodexUserTurnProvenance,
  countCodexUserTurns,
  findFirstCodexUserTurn,
  isCodexUserResponseEntry,
} from "../../src/sessions/codex-user-turn-provenance.js";

function userResponse(
  timestamp: string,
  texts: string[],
  extraContent: Array<Record<string, unknown>> = [],
): CodexSessionEntry {
  return {
    type: "response_item",
    timestamp,
    payload: {
      type: "message",
      role: "user",
      content: [
        ...texts.map((text) => ({ type: "input_text" as const, text })),
        ...extraContent,
      ],
    },
  } as CodexSessionEntry;
}

function userEvent(timestamp: string, message: string): CodexSessionEntry {
  return {
    type: "event_msg",
    timestamp,
    payload: { type: "user_message", message },
  };
}

function completedUserEvent(
  timestamp: string,
  message: string,
  clientId = "client-message-1",
): CodexSessionEntry {
  return {
    type: "event_msg",
    timestamp,
    payload: {
      type: "item_completed",
      thread_id: "thread-1",
      turn_id: "turn-1",
      item: {
        type: "UserMessage",
        id: "item-user-1",
        client_id: clientId,
        content: [{ type: "text", text: message, text_elements: [] }],
      },
    },
  };
}

function responseKind(
  entries: CodexSessionEntry[],
  index: number,
): string | undefined {
  const entry = entries[index];
  if (!isCodexUserResponseEntry(entry)) return undefined;
  return buildCodexUserTurnProvenance(entries).responseKinds.get(entry);
}

describe("Codex user-turn provenance", () => {
  it("pairs the real prompt after plugin and environment startup context", () => {
    const entries = [
      userResponse("2026-07-10T17:09:45.684Z", [
        "<recommended_plugins>\n- GitHub\n</recommended_plugins>",
        "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
      ]),
      userResponse("2026-07-10T17:09:45.686Z", ["actual first turn"]),
      userEvent("2026-07-10T17:09:45.686Z", "actual first turn"),
    ];

    expect(responseKind(entries, 0)).toBe("hidden-provider-context");
    expect(responseKind(entries, 1)).toBe("user-authored");
    expect(findFirstCodexUserTurn(entries)).toMatchObject({
      text: "actual first turn",
      source: "paired",
    });
    expect(countCodexUserTurns(entries)).toBe(1);
  });

  it("does not depend on an AGENTS fragment being present", () => {
    const entries = [
      userResponse("2026-07-10T17:09:45.684Z", [
        "<recommended_plugins>\n- GitHub\n</recommended_plugins>",
        [
          "# AGENTS.md instructions for /repo",
          "<INSTRUCTIONS>",
          "Follow the project instructions.",
          "</INSTRUCTIONS>",
        ].join("\n"),
        "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
      ]),
      userResponse("2026-07-10T17:09:45.686Z", ["actual first turn"]),
      userEvent("2026-07-10T17:09:45.686Z", "actual first turn"),
    ];

    expect(responseKind(entries, 0)).toBe("hidden-provider-context");
    expect(findFirstCodexUserTurn(entries)?.text).toBe("actual first turn");
  });

  it("pairs Codex 0.151 completed user items", () => {
    const entries = [
      userResponse("2026-08-30T08:46:03.691Z", ["peer is clear"]),
      completedUserEvent("2026-08-30T08:46:03.729Z", "peer is clear"),
    ];

    expect(responseKind(entries, 0)).toBe("user-authored");
    expect(findFirstCodexUserTurn(entries)).toMatchObject({
      text: "peer is clear",
      source: "paired",
    });
    expect(countCodexUserTurns(entries)).toBe(1);
  });

  it("preserves a paired literal context tag as user-authored", () => {
    const literalPrompt =
      "<environment_context>\nI typed this myself\n</environment_context>";
    const entries = [
      userResponse("2026-07-10T17:09:45.686Z", [literalPrompt]),
      userEvent("2026-07-10T17:09:45.686Z", literalPrompt),
    ];

    expect(responseKind(entries, 0)).toBe("user-authored");
    expect(findFirstCodexUserTurn(entries)?.text).toBe(literalPrompt);
  });

  it("uses the event as provenance while retaining an image response", () => {
    const entries = [
      userResponse(
        "2026-07-10T17:09:45.686Z",
        ["Review this image", '<image name="diagram.png">'],
        [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
      ),
      userEvent("2026-07-10T17:09:45.687Z", "Review this image"),
    ];
    const provenance = buildCodexUserTurnProvenance(entries);
    const response = entries[0];

    expect(isCodexUserResponseEntry(response)).toBe(true);
    if (!isCodexUserResponseEntry(response)) {
      throw new Error("expected user response");
    }
    expect(provenance.responseKinds.get(response)).toBe("user-authored");
    expect(response.payload.content).toHaveLength(3);
    expect(findFirstCodexUserTurn(entries)?.text).toBe("Review this image");
  });

  it("does not commit a trailing unpaired current-format response", () => {
    const entries = [
      userResponse("2026-07-10T17:09:45.686Z", ["first"]),
      userEvent("2026-07-10T17:09:45.687Z", "first"),
      userResponse("2026-07-10T17:10:45.686Z", ["still being persisted"]),
    ];

    expect(responseKind(entries, 2)).toBe("hidden-provider-context");
    expect(countCodexUserTurns(entries)).toBe(1);
  });

  it("keeps unknown legacy responses but filters known legacy context", () => {
    const entries = [
      userResponse("2024-01-01T00:00:00Z", [
        "<environment_context>\n<cwd>/repo</cwd>\n</environment_context>",
      ]),
      userResponse("2024-01-01T00:00:01Z", ["legacy actual prompt"]),
      userResponse("2024-01-01T00:00:02Z", [
        "<turn_aborted>\nInterrupted\n</turn_aborted>",
      ]),
    ];

    expect(responseKind(entries, 0)).toBe("hidden-provider-context");
    expect(responseKind(entries, 1)).toBe("legacy-unknown");
    expect(responseKind(entries, 2)).toBe("hidden-provider-context");
    expect(findFirstCodexUserTurn(entries)?.text).toBe("legacy actual prompt");
    expect(countCodexUserTurns(entries)).toBe(1);
  });

  it("keeps event-only legacy user turns", () => {
    const entries = [userEvent("2024-01-01T00:00:01Z", "event-only prompt")];

    expect(findFirstCodexUserTurn(entries)).toMatchObject({
      text: "event-only prompt",
      source: "event-only",
    });
    expect(countCodexUserTurns(entries)).toBe(1);
  });

  it("classifies hook prompts separately from user authorship", () => {
    const entries = [
      userResponse("2026-07-10T17:09:45.686Z", [
        '<hook_prompt hook_run_id="hook-1">Retry carefully.</hook_prompt>',
      ]),
    ];

    expect(responseKind(entries, 0)).toBe("visible-provider-context");
    expect(countCodexUserTurns(entries)).toBe(0);
  });
});
