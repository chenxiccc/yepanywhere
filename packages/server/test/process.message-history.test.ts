import { describe, expect, it } from "vitest";
import {
  MessageQueue,
  Process,
  createMockIterator,
} from "./process.test-support.js";
import type { SDKMessage, UrlProjectId } from "./process.test-support.js";

describe("Process", () => {
  describe("messageHistory", () => {
    it("should add user messages to history for real SDK sessions (with queue)", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue, // Real SDK provides queue
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // User message SHOULD be in history for replay to late-joining clients.
      // Client-side deduplication (mergeStreamMessage, mergeJSONLMessages) handles
      // any duplicates when JSONL is eventually fetched.
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.message?.content).toBe("test message");
    });

    it("should add user messages to history for mock SDK sessions (no queue)", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        // No queue = mock SDK
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // User message SHOULD be in history (mock SDK needs replay)
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      expect(userMessages[0]?.message?.content).toBe("test message");
    });

    it("should always emit user messages via stream regardless of SDK type", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue, // Real SDK
      });

      const emittedMessages: SDKMessage[] = [];
      process.subscribe((event) => {
        if (event.type === "message") {
          emittedMessages.push(event.message);
        }
      });

      // Queue a user message
      process.queueMessage({ text: "test message" });

      // Message should still be emitted for live stream subscribers
      const userEmits = emittedMessages.filter((m) => m.type === "user");
      expect(userEmits).toHaveLength(1);
    });

    it("should include attachment info in user message content", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      // Queue a user message with attachments
      process.queueMessage({
        text: "Here is a screenshot",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            name: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
        ],
      });

      // User message should include attachment info in content
      const userMessages = process
        .getMessageHistory()
        .filter((m) => m.type === "user");
      expect(userMessages).toHaveLength(1);
      const content = userMessages[0]?.message?.content as string;
      expect(content).toContain("Here is a screenshot");
      expect(content).toContain("User uploaded files:");
      expect(content).toContain("screenshot.png");
      expect(content).toContain("1\u202fkb");
      expect(content).toContain("image/png");
      expect(content).toContain("/uploads/screenshot.png");
    });

    it("should produce identical content format as MessageQueue for deduplication", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);
      const queue = new MessageQueue();

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });

      const testMessage = {
        text: "Here is a screenshot",
        attachments: [
          {
            id: "file-1",
            originalName: "screenshot.png",
            name: "screenshot.png",
            size: 1024,
            mimeType: "image/png",
            path: "/uploads/screenshot.png",
          },
          {
            id: "file-2",
            originalName: "document.pdf",
            name: "document.pdf",
            size: 2048576, // ~2 MB
            mimeType: "application/pdf",
            path: "/uploads/document.pdf",
          },
        ],
      };

      // Queue the message through Process
      process.queueMessage(testMessage);

      // Get what Process put in history
      const historyContent = process.getMessageHistory()[0]?.message
        ?.content as string;

      // Get what MessageQueue would send to SDK via its generator
      const gen = queue.generator();
      const sdkMessage = await gen.next();
      const sdkContent = sdkMessage.value?.message?.content as string;

      // Both should produce identical content for deduplication to work
      expect(historyContent).toBe(sdkContent);
    });
  });
});
