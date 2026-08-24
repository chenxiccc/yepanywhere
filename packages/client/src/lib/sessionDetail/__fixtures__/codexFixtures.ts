import type { PaginationInfo } from "../../../api/client";
import type { Message, SessionMetadata } from "../../../types";
import type { SessionDetailAction } from "../types";

type PersistedTranscriptFields = Omit<
  Extract<SessionDetailAction, { type: "loadPersistedTranscript" }>,
  "type"
>;

interface CodexFixture {
  session: SessionMetadata;
  persisted: PersistedTranscriptFields;
  streamMessages: Message[];
  replayMessages?: Message[];
}

const codexSession = {
  id: "019b8510-300f-7dc2-9129-03f5bd8d360e",
  projectId: "proj_yepanywhere_fixture",
  provider: "codex",
  title: "Codex fixture session",
  fullTitle: "Codex fixture session",
  createdAt: "2026-07-01T12:00:00.000Z",
  updatedAt: "2026-07-01T12:00:08.000Z",
  messageCount: 2,
  ownership: { owner: "none" },
} as SessionMetadata;

const twoMessagePagination: PaginationInfo = {
  hasOlderMessages: false,
  totalMessageCount: 2,
  returnedMessageCount: 2,
  totalCompactions: 0,
};

function textBlock(text: string) {
  return { type: "text" as const, text };
}

function userMessage(
  uuid: string,
  timestamp: string,
  text: string,
  extra: Partial<Message> = {},
): Message {
  const content = [textBlock(text)];
  return {
    uuid,
    type: "user",
    timestamp,
    content,
    message: {
      role: "user",
      content,
    },
    ...extra,
  } as Message;
}

function assistantMessage(
  uuid: string,
  timestamp: string,
  text: string,
  extra: Partial<Message> = {},
): Message {
  const content = [textBlock(text)];
  return {
    uuid,
    type: "assistant",
    timestamp,
    content,
    message: {
      role: "assistant",
      content,
    },
    ...extra,
  } as Message;
}

function toolUseMessage(
  uuid: string,
  timestamp: string,
  callId: string,
): Message {
  const content = [
    {
      type: "tool_use" as const,
      id: callId,
      name: "Bash",
      input: { cmd: "git status --short" },
    },
  ];
  return {
    uuid,
    type: "assistant",
    timestamp,
    content,
    message: {
      role: "assistant",
      content,
    },
  } as Message;
}

function withReplay(message: Message): Message {
  return {
    ...message,
    isReplay: true,
  };
}

// Stream, replay, and durable rows carry the same provider-log identity.
export const codexReplayCatchupDuplicatePromptFixture: CodexFixture = {
  session: codexSession,
  streamMessages: [
    userMessage(
      "optimistic-opening-turn",
      "2026-07-01T12:00:00.184Z",
      "Summarize the reducer fixture coverage.",
    ),
    assistantMessage(
      "item_1_live_agent_message",
      "2026-07-01T12:00:07.120Z",
      "The reducer fixture coverage now exercises stream and persisted input.",
    ),
  ],
  replayMessages: [
    withReplay(
      userMessage(
        "optimistic-opening-turn",
        "2026-07-01T12:00:00.184Z",
        "Summarize the reducer fixture coverage.",
      ),
    ),
    withReplay(
      assistantMessage(
        "item_1_live_agent_message",
        "2026-07-01T12:00:07.120Z",
        "The reducer fixture coverage now exercises stream and persisted input.",
      ),
    ),
  ],
  persisted: {
    session: codexSession,
    messages: [
      userMessage(
        "optimistic-opening-turn",
        "2026-07-01T12:00:06.218Z",
        "Summarize the reducer fixture coverage.",
      ),
      assistantMessage(
        "item_1_live_agent_message",
        "2026-07-01T12:00:07.780Z",
        "The reducer fixture coverage now exercises stream and persisted input.",
      ),
    ],
    pagination: twoMessagePagination,
  },
};

const attachmentPrompt = "Inspect this screenshot and summarize the issue.";
const attachmentPath =
  "/Users/kgraehl/code/yepanywhere/.attachments/019b8510/image.png";

export const codexAttachmentOpeningTurnFixture: CodexFixture = {
  session: {
    ...codexSession,
    id: "019b8510-6e5b-7d40-a2e5-33cfc07528cc",
    messageCount: 1,
  } as SessionMetadata,
  streamMessages: [
    userMessage(
      "optimistic-attachment-opening-turn",
      "2026-07-01T12:20:00.410Z",
      attachmentPrompt,
      {
        attachments: [
          {
            id: "file_019b8510_attachment",
            originalName: "image.png",
            path: attachmentPath,
            size: 42000,
            mimeType: "image/png",
          },
        ],
      },
    ),
  ],
  persisted: {
    session: {
      ...codexSession,
      id: "019b8510-6e5b-7d40-a2e5-33cfc07528cc",
      messageCount: 1,
    } as SessionMetadata,
    messages: [
      userMessage(
        "optimistic-attachment-opening-turn",
        "2026-07-01T12:20:09.744Z",
        `${attachmentPrompt}\n\nUser uploaded files in .attachments:\n- [image.png](<${attachmentPath}>) (42 kb, image/png, 321x460)`,
      ),
    ],
    pagination: {
      ...twoMessagePagination,
      totalMessageCount: 1,
      returnedMessageCount: 1,
    },
  },
};

export const codexRepeatedToolCallsFixture: CodexFixture = {
  session: {
    ...codexSession,
    id: "019b8510-7a3a-7348-9fd5-b12ace1daef4",
    messageCount: 2,
  } as SessionMetadata,
  streamMessages: [],
  persisted: {
    session: {
      ...codexSession,
      id: "019b8510-7a3a-7348-9fd5-b12ace1daef4",
      messageCount: 2,
    } as SessionMetadata,
    messages: [
      toolUseMessage(
        "response_item_call_019b8510_0001",
        "2026-07-01T12:30:00.000Z",
        "call_019b8510_a",
      ),
      toolUseMessage(
        "response_item_call_019b8510_0002",
        "2026-07-01T12:30:00.300Z",
        "call_019b8510_b",
      ),
    ],
    pagination: twoMessagePagination,
  },
};
