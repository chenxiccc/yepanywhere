import { describe, expect, it } from "vitest";
import { CodexSessionEntrySchema } from "../src/codex-schema/session.js";

describe("CodexSessionEntrySchema", () => {
  it.each([
    {
      timestamp: "2026-07-10T00:00:00Z",
      type: "world_state",
      payload: { full: true, state: { agents_md: {} } },
    },
    {
      timestamp: "2026-07-10T00:00:00Z",
      type: "event_msg",
      payload: {
        type: "patch_apply_end",
        call_id: "exec-1",
        success: true,
        changes: { "/repo/a.txt": { type: "add", content: "hello" } },
      },
    },
    {
      timestamp: "2026-07-10T00:00:00Z",
      type: "event_msg",
      payload: { type: "thread_settings_applied", thread_settings: {} },
    },
    {
      timestamp: "2026-07-10T00:00:00Z",
      type: "event_msg",
      payload: { type: "thread_rolled_back", num_turns: 1 },
    },
    {
      timestamp: "2026-07-27T00:00:00Z",
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        event_id: "activity-1",
        occurred_at_ms: 1_785_000_000_000,
        agent_thread_id: "thread-1",
        agent_path: "explore",
        kind: "started",
      },
    },
    {
      timestamp: "2026-07-27T00:00:00Z",
      type: "inter_agent_communication_metadata",
      payload: { trigger_turn: true },
    },
    {
      timestamp: "2026-07-10T00:00:00Z",
      type: "event_msg",
      payload: {
        type: "token_count",
        info: null,
        rate_limits: { primary: null },
      },
    },
    {
      timestamp: "2026-07-10T00:00:00Z",
      type: "response_item",
      payload: {
        type: "tool_search_call",
        call_id: "search-1",
        execution: "list tools",
        arguments: {},
      },
    },
  ])("accepts a current persisted %# entry", (entry) => {
    expect(CodexSessionEntrySchema.safeParse(entry).success).toBe(true);
  });

  it("preserves response item and turn identity used by server fork resolution", () => {
    const parsed = CodexSessionEntrySchema.parse({
      timestamp: "2026-08-01T07:38:02.999Z",
      type: "response_item",
      payload: {
        id: "msg-provider-1",
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "done" }],
        internal_chat_message_metadata_passthrough: {
          turn_id: "turn-provider-1",
        },
      },
    });

    expect(parsed.type).toBe("response_item");
    if (parsed.type !== "response_item") return;
    expect(parsed.payload).toMatchObject({
      id: "msg-provider-1",
      internal_chat_message_metadata_passthrough: {
        turn_id: "turn-provider-1",
      },
    });
  });

  it("accepts standalone named function outputs", () => {
    const parsed = CodexSessionEntrySchema.parse({
      timestamp: "2026-08-26T00:00:00.000Z",
      type: "response_item",
      payload: {
        type: "function_call_output",
        name: "notifications",
        namespace: "slack",
        output: "new message",
      },
    });

    expect(parsed.type).toBe("response_item");
    if (parsed.type !== "response_item") return;
    expect(parsed.payload).toMatchObject({
      name: "notifications",
      namespace: "slack",
      output: "new message",
    });
  });

  it("preserves the client id persisted with a user message event", () => {
    const parsed = CodexSessionEntrySchema.parse({
      timestamp: "2026-08-24T12:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "wait 10 minutes",
        client_id: "ya-user-1",
      },
    });

    expect(parsed.type).toBe("event_msg");
    if (parsed.type !== "event_msg") return;
    expect(parsed.payload).toMatchObject({ client_id: "ya-user-1" });
  });
});
