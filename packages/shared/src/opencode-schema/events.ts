/**
 * Event schemas for OpenCode server SSE events.
 *
 * OpenCode server emits Server-Sent Events (SSE) with these types:
 * - server.connected: Initial connection established
 * - session.status: Session busy/idle state changes
 * - session.updated: Session metadata updated
 * - session.idle: Session finished processing
 * - message.updated: Message metadata updated
 * - message.part.updated: Message content streaming (with delta)
 * - message.part.delta: Incremental field delta for an existing part
 * - session.diff: File diff information
 */

import { z } from "zod";

/**
 * Session status from OpenCode.
 */
export const OpenCodeSessionStatusSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("idle") }),
  z.object({ type: z.literal("busy") }),
  z.object({
    type: z.literal("retry"),
    attempt: z.number(),
    message: z.string(),
    next: z.number(),
  }),
]);

export type OpenCodeSessionStatus = z.infer<typeof OpenCodeSessionStatusSchema>;

/**
 * Token usage stats from OpenCode.
 */
export const OpenCodeTokensSchema = z.object({
  input: z.number().optional(),
  output: z.number().optional(),
  reasoning: z.number().optional(),
  cache: z
    .object({
      read: z.number().optional(),
      write: z.number().optional(),
    })
    .optional(),
});

export type OpenCodeTokens = z.infer<typeof OpenCodeTokensSchema>;

/**
 * Time information for parts/messages.
 */
export const OpenCodeTimeSchema = z.object({
  start: z.number().optional(),
  end: z.number().optional(),
  created: z.number().optional(),
  updated: z.number().optional(),
  completed: z.number().optional(),
});

export type OpenCodeTime = z.infer<typeof OpenCodeTimeSchema>;

/**
 * File attachment emitted on completed tool state. OpenCode uses data URLs
 * here for image reads.
 */
export const OpenCodeToolAttachmentSchema = z.object({
  type: z.string(),
  mime: z.string().optional(),
  url: z.string().optional(),
  filename: z.string().optional(),
  id: z.string().optional(),
  sessionID: z.string().optional(),
  messageID: z.string().optional(),
});

export type OpenCodeToolAttachment = z.infer<
  typeof OpenCodeToolAttachmentSchema
>;

/**
 * Message part - the streaming content unit.
 */
export const OpenCodePartSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  type: z.string(), // "text", "reasoning", "step-start", "step-finish", "tool", and legacy "tool-use"/"tool-result"
  text: z.string().optional(),
  time: OpenCodeTimeSchema.optional(),
  // step-finish specific fields
  reason: z.string().optional(),
  snapshot: z.string().optional(),
  cost: z.number().optional(),
  tokens: OpenCodeTokensSchema.optional(),
  // Unified tool part (opencode 1.16+): a single type:"tool" part carries the
  // call id plus a nested state that fills in across streaming updates
  // (pending -> running -> completed/error). Without these, zod would strip
  // them and live tool calls would be invisible.
  callID: z.string().optional(),
  state: z
    .object({
      status: z.string().optional(),
      input: z.unknown().optional(),
      output: z.unknown().optional(),
      error: z.string().optional(),
      title: z.string().optional(),
      metadata: z.unknown().optional(),
      attachments: z.array(OpenCodeToolAttachmentSchema).optional(),
      time: z
        .object({ start: z.number().optional(), end: z.number().optional() })
        .optional(),
    })
    .optional(),
  // Legacy split-part fields (older opencode "tool-use"/"tool-result")
  tool: z.string().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

export type OpenCodePart = z.infer<typeof OpenCodePartSchema>;

/**
 * Message info - metadata about a message.
 */
export const OpenCodeMessageInfoSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  role: z.enum(["user", "assistant"]),
  time: OpenCodeTimeSchema.optional(),
  parentID: z.string().optional(),
  modelID: z.string().optional(),
  providerID: z.string().optional(),
  mode: z.string().optional(),
  agent: z.string().optional(),
  path: z
    .object({
      cwd: z.string().optional(),
      root: z.string().optional(),
    })
    .optional(),
  cost: z.number().optional(),
  tokens: OpenCodeTokensSchema.optional(),
  finish: z.string().optional(),
  summary: z
    .object({
      title: z.string().optional(),
      diffs: z.array(z.unknown()).optional(),
    })
    .optional(),
  model: z
    .object({
      providerID: z.string().optional(),
      modelID: z.string().optional(),
    })
    .optional(),
});

export type OpenCodeMessageInfo = z.infer<typeof OpenCodeMessageInfoSchema>;

/**
 * Session info - metadata about a session.
 */
export const OpenCodeSessionInfoSchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  projectID: z.string().optional(),
  directory: z.string().optional(),
  title: z.string().optional(),
  time: OpenCodeTimeSchema.optional(),
  summary: z
    .object({
      additions: z.number().optional(),
      deletions: z.number().optional(),
      files: z.number().optional(),
    })
    .optional(),
});

export type OpenCodeSessionInfo = z.infer<typeof OpenCodeSessionInfoSchema>;

// ============ SSE Event Types ============

/**
 * Server connected event.
 */
export const OpenCodeServerConnectedEventSchema = z.object({
  type: z.literal("server.connected"),
  properties: z.object({}).optional(),
});

export type OpenCodeServerConnectedEvent = z.infer<
  typeof OpenCodeServerConnectedEventSchema
>;

/**
 * Session status event.
 */
export const OpenCodeSessionStatusEventSchema = z.object({
  type: z.literal("session.status"),
  properties: z.object({
    sessionID: z.string(),
    status: OpenCodeSessionStatusSchema,
  }),
});

export type OpenCodeSessionStatusEvent = z.infer<
  typeof OpenCodeSessionStatusEventSchema
>;

/**
 * Session updated event.
 */
export const OpenCodeSessionUpdatedEventSchema = z.object({
  type: z.literal("session.updated"),
  properties: z.object({
    info: OpenCodeSessionInfoSchema,
  }),
});

export type OpenCodeSessionUpdatedEvent = z.infer<
  typeof OpenCodeSessionUpdatedEventSchema
>;

/**
 * Session idle event.
 */
export const OpenCodeSessionIdleEventSchema = z.object({
  type: z.literal("session.idle"),
  properties: z.object({
    sessionID: z.string(),
  }),
});

export type OpenCodeSessionIdleEvent = z.infer<
  typeof OpenCodeSessionIdleEventSchema
>;

/**
 * Session diff event.
 */
export const OpenCodeSessionDiffEventSchema = z.object({
  type: z.literal("session.diff"),
  properties: z.object({
    sessionID: z.string(),
    diff: z.array(z.unknown()),
  }),
});

export type OpenCodeSessionDiffEvent = z.infer<
  typeof OpenCodeSessionDiffEventSchema
>;

/**
 * Message updated event.
 */
export const OpenCodeMessageUpdatedEventSchema = z.object({
  type: z.literal("message.updated"),
  properties: z.object({
    info: OpenCodeMessageInfoSchema,
  }),
});

export type OpenCodeMessageUpdatedEvent = z.infer<
  typeof OpenCodeMessageUpdatedEventSchema
>;

/**
 * Message part updated event (streaming content).
 */
export const OpenCodeMessagePartUpdatedEventSchema = z.object({
  type: z.literal("message.part.updated"),
  properties: z.object({
    part: OpenCodePartSchema,
    delta: z.string().optional(), // Streaming text delta
  }),
});

export type OpenCodeMessagePartUpdatedEvent = z.infer<
  typeof OpenCodeMessagePartUpdatedEventSchema
>;

/**
 * Message part delta event (incremental content).
 */
export const OpenCodeMessagePartDeltaEventSchema = z.object({
  type: z.literal("message.part.delta"),
  properties: z.object({
    sessionID: z.string(),
    messageID: z.string().optional(),
    partID: z.string(),
    field: z.string(),
    delta: z.string(),
  }),
});

export type OpenCodeMessagePartDeltaEvent = z.infer<
  typeof OpenCodeMessagePartDeltaEventSchema
>;

/**
 * Permission request (opencode asks before running a gated tool). The reply
 * goes to POST /permission/{id}/reply with {reply:"once"|"always"|"reject"}.
 */
export const OpenCodePermissionRequestSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  /** Permission/tool descriptor, e.g. "bash". */
  permission: z.string(),
  /** Matched patterns, e.g. ["echo PERM_OK"]. */
  patterns: z.array(z.string()).optional(),
  /** Tool input metadata, e.g. {command, description} for bash. */
  metadata: z.record(z.string(), z.unknown()).optional(),
  always: z.array(z.string()).optional(),
  tool: z
    .object({ messageID: z.string(), callID: z.string() })
    .partial()
    .optional(),
});

export type OpenCodePermissionRequest = z.infer<
  typeof OpenCodePermissionRequestSchema
>;

export const OpenCodePermissionAskedEventSchema = z.object({
  type: z.literal("permission.asked"),
  properties: OpenCodePermissionRequestSchema,
});

export type OpenCodePermissionAskedEvent = z.infer<
  typeof OpenCodePermissionAskedEventSchema
>;

/**
 * Interactive question (the agent's "interview" tool). Reply goes to
 * POST /question/{id}/reply with {answers: string[][]} (one array of selected
 * option labels per question, in order) or POST /question/{id}/reject.
 */
export const OpenCodeQuestionInfoSchema = z.object({
  question: z.string(),
  header: z.string(),
  options: z.array(
    z.object({ label: z.string(), description: z.string().optional() }),
  ),
  multiple: z.boolean().optional(),
  custom: z.boolean().optional(),
});

export type OpenCodeQuestionInfo = z.infer<typeof OpenCodeQuestionInfoSchema>;

export const OpenCodeQuestionAskedEventSchema = z.object({
  type: z.literal("question.asked"),
  properties: z.object({
    id: z.string(),
    sessionID: z.string(),
    questions: z.array(OpenCodeQuestionInfoSchema),
  }),
});

export type OpenCodeQuestionAskedEvent = z.infer<
  typeof OpenCodeQuestionAskedEventSchema
>;

/**
 * Union of all OpenCode SSE event types.
 */
export const OpenCodeSSEEventSchema = z.discriminatedUnion("type", [
  OpenCodeServerConnectedEventSchema,
  OpenCodeSessionStatusEventSchema,
  OpenCodeSessionUpdatedEventSchema,
  OpenCodeSessionIdleEventSchema,
  OpenCodeSessionDiffEventSchema,
  OpenCodeMessageUpdatedEventSchema,
  OpenCodeMessagePartUpdatedEventSchema,
  OpenCodeMessagePartDeltaEventSchema,
  OpenCodePermissionAskedEventSchema,
  OpenCodeQuestionAskedEventSchema,
]);

export type OpenCodeSSEEvent = z.infer<typeof OpenCodeSSEEventSchema>;

/**
 * Parse an SSE data line into an OpenCode event.
 * Returns null if parsing fails.
 */
export function parseOpenCodeSSEEvent(data: string): OpenCodeSSEEvent | null {
  try {
    const json = JSON.parse(data);
    const result = OpenCodeSSEEventSchema.safeParse(json);
    if (result.success) {
      return result.data;
    }
    // Return as unknown event for forward compatibility
    if (json && typeof json === "object" && "type" in json) {
      return json as OpenCodeSSEEvent;
    }
    return null;
  } catch {
    return null;
  }
}
