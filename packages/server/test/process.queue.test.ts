import { describe, expect, it, vi } from "vitest";
import {
  MessageQueue,
  Process,
  createMockIterator,
  waitFor,
} from "./process.test-support.js";
import type { SDKMessage, UrlProjectId } from "./process.test-support.js";

describe("MessageQueue", () => {
  it("settles a pending iterator return without another queued message", async () => {
    const queue = new MessageQueue();
    const iterator = queue.generator();
    const pendingNext = iterator.next();
    await waitFor(() => expect(queue.isWaiting).toBe(true));

    let timeout: ReturnType<typeof setTimeout> | null = null;
    const returnResult = await Promise.race([
      iterator
        .return()
        .then((result) => ({ type: "returned" as const, result })),
      new Promise<{ type: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ type: "timeout" }), 100);
      }),
    ]);
    if (timeout) clearTimeout(timeout);

    expect(returnResult.type).toBe("returned");
    if (returnResult.type === "returned") {
      expect(returnResult.result).toEqual({ done: true, value: undefined });
    }
    await expect(pendingNext).resolves.toEqual({
      done: true,
      value: undefined,
    });
  });
});

describe("Process", () => {
  describe("message queue", () => {
    it("reports when a human turn is yielded to provider input", async () => {
      let resolveIterator!: (result: IteratorResult<SDKMessage>) => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = resolve;
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
      });
      const started = vi.fn();
      const accepted = vi.fn();
      process.subscribe((event) => {
        if (event.type === "provider-turn-started") {
          started(event.startedAtMs);
        } else if (event.type === "user-turn-accepted") {
          accepted(event.startedAtMs);
        }
      });

      const serverReceivedAt = new Date().toISOString();
      process.queueMessage({
        text: "provider-bound",
        metadata: { serverReceivedAt },
      });
      await queue[Symbol.asyncIterator]().next();

      expect(accepted).toHaveBeenCalledWith(Date.parse(serverReceivedAt));
      expect(started).toHaveBeenCalledTimes(1);
      expect(started).toHaveBeenCalledWith(expect.any(Number));
      resolveIterator({ done: true, value: undefined });
      await process.abort();
    });

    it("queues messages and returns position", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      const result1 = process.queueMessage({ text: "first" });
      const result2 = process.queueMessage({ text: "second" });

      expect(result1.success).toBe(true);
      expect(result1.position).toBe(1);
      expect(result2.success).toBe(true);
      expect(result2.position).toBe(2);
    });

    it("reports queue depth", async () => {
      const iterator = createMockIterator([
        { type: "system", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      process.queueMessage({ text: "first" });
      process.queueMessage({ text: "second" });

      expect(process.queueDepth).toBe(2);
    });

    it("prefers steerFn for in-turn messages when available", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      const result = process.queueMessage({ text: "steer me" });

      expect(result.success).toBe(true);
      expect(result.position).toBe(0);
      expect(steerFn).toHaveBeenCalledTimes(1);
      expect(process.queueDepth).toBe(0);

      // Let the iterator complete so abort() doesn't hang
      resolveIterator?.();
      await process.abort();
    });

    it("replays steer echoes until the provider turn ends", async () => {
      vi.useFakeTimers();
      try {
        let resolveIterator!: (result: IteratorResult<SDKMessage>) => void;
        const iterator: AsyncIterator<SDKMessage> = {
          next: () =>
            new Promise((resolve) => {
              resolveIterator = resolve;
            }),
        };
        const process = new Process(iterator, {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-1",
          provider: "codex",
          idleTimeoutMs: 1_000_000,
          queue: new MessageQueue(),
          steerFn: vi.fn(async () => true),
        });

        process.queueMessage({
          text: "survive a reload",
          tempId: "temp-steer",
          metadata: { deliveryIntent: "steer" },
        });

        // Roll both ordinary 15-second history buckets out. The steer has no
        // durable provider row yet, so reconnect replay must still include it.
        vi.advanceTimersByTime(31_000);
        expect(
          process.getMessageHistory().map((message) => message.tempId),
        ).toContain("temp-steer");

        resolveIterator({
          done: false,
          value: { type: "result" } as SDKMessage,
        });
        await Promise.resolve();
        await Promise.resolve();

        // The turn boundary moves the aged echo back into ordinary replay to
        // cover the short durable-write gap.
        expect(
          process.getMessageHistory().map((message) => message.tempId),
        ).toContain("temp-steer");

        // Retention is still bounded: ordinary buckets expire both messages.
        vi.advanceTimersByTime(31_000);
        expect(process.getMessageHistory()).toEqual([]);

        resolveIterator({ done: true, value: undefined });
        await Promise.resolve();
        await process.abort();
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels a steered message before the provider queue consumes it", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const steerFn = vi.fn(async (message) => {
        queue.push(message);
        return true;
      });

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      process.queueMessage({
        text: "cancel me",
        tempId: "temp-steer",
        metadata: { deliveryIntent: "steer" },
      });

      expect(process.queueDepth).toBe(1);
      expect(
        process.getMessageHistory().map((message) => message.tempId),
      ).toEqual(["temp-steer"]);
      expect(process.cancelUnconfirmedSteerMessage("temp-steer")).toBe(true);
      expect(process.queueDepth).toBe(0);
      expect(process.getMessageHistory()).toEqual([]);
      expect(process.cancelUnconfirmedSteerMessage("temp-steer")).toBe(false);

      resolveIterator?.();
      await process.abort();
    });

    it("does not cancel steering after the provider queue consumes it", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const steerFn = vi.fn(async (message) => {
        queue.push(message);
        return true;
      });

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      process.queueMessage({
        text: "already consumed",
        tempId: "temp-steer",
        metadata: { deliveryIntent: "steer" },
      });
      await queue[Symbol.asyncIterator]().next();

      expect(process.cancelUnconfirmedSteerMessage("temp-steer")).toBe(false);
      expect(process.getMessageHistory()).toHaveLength(1);

      resolveIterator?.();
      await process.abort();
    });

    it("marks Claude steer-now messages with now priority", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => true);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      process.queueMessage({
        text: "steer immediately",
        metadata: { deliveryIntent: "steer", steerNow: true },
      });

      expect(steerFn).toHaveBeenCalledWith(
        expect.objectContaining({
          text: "steer immediately",
          priority: "now",
        }),
      );

      resolveIterator?.();
      await process.abort();
    });

    it("falls back to queue when steerFn returns false", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const steerFn = vi.fn(async () => false);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        steerFn,
      });

      const result = process.queueMessage({ text: "fallback me" });
      expect(result.success).toBe(true);
      expect(result.position).toBe(0);

      // steerFn returns a resolved promise, then .then() pushes to queue —
      // need 2 microtask ticks for both to settle
      await Promise.resolve();
      await Promise.resolve();
      expect(process.queueDepth).toBe(1);

      // Let the iterator complete so abort() doesn't hang
      resolveIterator?.();
      await process.abort();
    });

    it("reports handled:false for providers without native command dispatch", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue: new MessageQueue(),
      });

      const result = await process.runProviderCommand("compact", "preserve X");
      expect(result).toEqual({ handled: false });

      resolveIterator?.();
      await process.abort();
    });

    it("delegates native commands to runProviderCommandFn", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const runProviderCommandFn = vi.fn(async () => ({ handled: true }));
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        queue: new MessageQueue(),
        runProviderCommandFn,
      });

      const result = await process.runProviderCommand("compact", "preserve X");
      expect(result).toEqual({ handled: true });
      expect(runProviderCommandFn).toHaveBeenCalledWith(
        "compact",
        "preserve X",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("publishes provider command output for live delivery and replay", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        queue: new MessageQueue(),
        runProviderCommandFn: vi.fn(async () => ({
          handled: true,
          output: {
            summary: "/status",
            details: ["Model: gpt-5.6"],
          },
        })),
      });
      const liveMessages: SDKMessage[] = [];
      const unsubscribe = process.subscribe((event) => {
        if (event.type === "message") liveMessages.push(event.message);
      });

      await process.runProviderCommand("status");

      const expected = expect.objectContaining({
        type: "system",
        subtype: "local_command",
        content: "/status",
        details: ["Model: gpt-5.6"],
        session_id: "sess-1",
        isSynthetic: true,
      });
      expect(liveMessages).toEqual([expected]);
      expect(process.getMessageHistory()).toEqual([expected]);

      unsubscribe();
      resolveIterator?.();
      await process.abort();
    });

    it("expands cached slash-command emulation before queueing", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        supportedCommandsFn: async () => [
          {
            name: "goal",
            description: "Keep working until done",
            emulation: { providerText: "/loop wish {{argument}}" },
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "/goal Make tests pass",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "/loop wish Make tests pass",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "/loop wish Make tests pass",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("expands hyphenated slash-command emulation before queueing", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        queue,
        supportedCommandsFn: async () => [
          {
            name: "harsh-review",
            description: "Strict review",
            emulation: { providerText: "@harsh-review {{argument}}" },
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "/harsh-review on last 3 commits",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "@harsh-review on last 3 commits",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "@harsh-review on last 3 commits",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("keeps unknown Codex slash-shaped text literal", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
        provider: "codex",
        supportedCommandsFn: async () => [
          {
            name: "goal",
            description: "Keep working until done",
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "/harsh-review on last 3 commits",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "/harsh-review on last 3 commits",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "/harsh-review on last 3 commits",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("canonicalizes recognized Codex skills anywhere in the message", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
        provider: "codex",
        supportedCommandsFn: async () => [
          {
            name: "doubt",
            description: "Verify independently",
            invocation: { kind: "skill", prefix: "$" },
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "Check this with /doubt and leave /unknown literal",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "Check this with $doubt and leave /unknown literal",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "Check this with $doubt and leave /unknown literal",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("keeps native Codex slash commands as slash commands", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
        provider: "codex",
        supportedCommandsFn: async () => [
          {
            name: "goal",
            description: "Keep working until done",
          },
        ],
      });

      await process.supportedCommands();
      const result = process.queueMessage({
        text: "/goal Make tests pass",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe(
        "/goal Make tests pass",
      );
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe(
        "/goal Make tests pass",
      );

      resolveIterator?.();
      await process.abort();
    });

    it("keeps native Codex compact as a slash command before commands are cached", async () => {
      let resolveIterator!: () => void;
      const iterator: AsyncIterator<SDKMessage> = {
        next: () =>
          new Promise((resolve) => {
            resolveIterator = () => resolve({ done: true, value: undefined });
          }),
      };
      const queue = new MessageQueue();
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        idleTimeoutMs: 100,
        queue,
        provider: "codex",
        supportedCommandsFn: async () => [],
      });

      const result = process.queueMessage({
        text: "/compact",
      });

      expect(result.success).toBe(true);
      expect(process.getMessageHistory()[0]?.message?.content).toBe("/compact");
      const queuedProviderTurn = await queue[Symbol.asyncIterator]().next();
      expect(queuedProviderTurn.value?.message.content).toBe("/compact");

      resolveIterator?.();
      await process.abort();
    });
  });
});
