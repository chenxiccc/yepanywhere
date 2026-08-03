import {
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  Process,
  createMockIterator,
} from "./process.test-support.js";
import type {
  ProcessEvent,
  SDKMessage,
  UrlProjectId,
} from "./process.test-support.js";

describe("Process", () => {
  describe("process termination", () => {
    it("isTerminated returns false for new process", async () => {
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
      ]);

      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      expect(process.isTerminated).toBe(false);
      expect(process.terminationReason).toBe(null);
    });

    it("queueMessage returns error when process is terminated", async () => {
      // Create an iterator that throws a process termination error
      const error = new Error("ProcessTransport is not ready for writing");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      // Wait for the iterator to process and fail
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      // Now queueMessage should return an error
      const result = process.queueMessage({ text: "should fail" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("terminated");
    });

    it("rejects new input once reload-safe detach begins", async () => {
      let releaseAbort: (() => void) | undefined;
      const abortPending = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      const process = new Process(
        createMockIterator([
          { type: "system", subtype: "init", session_id: "sess-reload" },
        ]),
        {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-reload",
          provider: "codex",
          idleTimeoutMs: 100,
          abortFn: () => abortPending,
        },
      );
      await vi.waitFor(() => expect(process.state.type).toBe("idle"));

      const detach = process.detachForServerReload();
      const result = process.queueMessage({ text: "must not be lost" });

      expect(result).toEqual({
        success: false,
        error: "Process is detaching for server reload",
      });
      releaseAbort?.();
      await detach;
    });

    it("emits terminated event when process dies", async () => {
      const error = new Error("ProcessTransport is not ready for writing");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      let terminatedEvent: { reason: string; error?: Error } | null = null;
      process.subscribe((event) => {
        if (event.type === "terminated") {
          terminatedEvent = { reason: event.reason, error: event.error };
        }
      });

      // Wait for the terminated event
      await vi.waitFor(() => {
        expect(terminatedEvent).not.toBe(null);
      });

      // terminatedEvent is only assigned inside the subscribe callback, so
      // control-flow analysis narrows it back to its `null` initializer here;
      // read through the declared type to access the captured fields.
      const captured = terminatedEvent as {
        reason: string;
        error?: Error;
      } | null;
      expect(captured?.reason).toContain("terminated");
      expect(captured?.error).toBe(error);
    });

    it("getInfo returns terminated state", async () => {
      const error = new Error("process exited");
      async function* failingIterator(): AsyncIterator<SDKMessage> {
        yield { type: "system", subtype: "init", session_id: "sess-1" };
        throw error;
      }

      const process = new Process(failingIterator(), {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      // Wait for termination
      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      const info = process.getInfo();
      expect(info.state).toBe("terminated");
    });

    it("terminates after emitting a Claude SDK API error message", async () => {
      const apiError: SDKMessage = {
        type: "assistant",
        uuid: "25f342b9-efa8-416c-9e9b-e617f61af756",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: [
            {
              type: "text",
              text: "API Error: 529 Overloaded. This is a server-side issue, usually temporary.",
            },
          ],
        },
        isApiErrorMessage: true,
        apiErrorStatus: 529,
      };
      const abortFn = vi.fn();
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
        apiError,
      ]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        abortFn,
      });

      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      await vi.waitFor(() => {
        expect(process.isTerminated).toBe(true);
      });

      const messageEventIndex = events.findIndex(
        (event) =>
          event.type === "message" &&
          event.message.type === "assistant" &&
          event.message.uuid === apiError.uuid &&
          event.message.isApiErrorMessage === true &&
          event.message.apiErrorStatus === 529,
      );
      const terminatedEventIndex = events.findIndex(
        (event) => event.type === "terminated",
      );

      expect(messageEventIndex).toBeGreaterThanOrEqual(0);
      expect(terminatedEventIndex).toBeGreaterThan(messageEventIndex);
      expect(process.terminationReason).toBe(
        "Claude SDK API error; restart required",
      );
      expect(abortFn).toHaveBeenCalledOnce();
      expect(process.queueMessage({ text: "should fail" }).success).toBe(false);
    });

    it("does not terminate non-Claude processes on Claude-shaped API errors", async () => {
      const apiError: SDKMessage = {
        type: "assistant",
        message: {
          model: "<synthetic>",
          role: "assistant",
          content: "API Error: 529 Overloaded.",
        },
        isApiErrorMessage: true,
        apiErrorStatus: 529,
      };
      const iterator = createMockIterator([
        { type: "system", subtype: "init", session_id: "sess-1" },
        apiError,
        { type: "result", session_id: "sess-1" },
      ]);
      const process = new Process(iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      await vi.waitFor(() => {
        expect(process.state.type).toBe("idle");
      });

      expect(process.isTerminated).toBe(false);
    });

    it("awaits provider shutdown and verifies provider liveness", async () => {
      let resolveShutdown: (() => void) | undefined;
      let alive = true;
      const shutdown = new Promise<void>((resolve) => {
        resolveShutdown = () => {
          alive = false;
          resolve();
        };
      });
      const process = new Process(
        createMockIterator([
          { type: "system", subtype: "init", session_id: "sess-verified" },
        ]),
        {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-verified",
          provider: "codex",
          abortFn: () => shutdown,
          isProcessAlive: () => alive,
        },
      );

      const abortResult = process.abort();
      await Promise.resolve();
      expect(alive).toBe(true);

      resolveShutdown?.();
      await expect(abortResult).resolves.toMatchObject({
        sessionId: "sess-verified",
        verifiedStopped: true,
        verification: "provider",
      });
    });

    it("rejects an abort when the provider still reports a live process", async () => {
      const process = new Process(
        createMockIterator([
          { type: "system", subtype: "init", session_id: "sess-still-live" },
        ]),
        {
          projectPath: "/test",
          projectId: "proj-1" as UrlProjectId,
          sessionId: "sess-still-live",
          provider: "codex",
          abortFn: vi.fn(),
          isProcessAlive: () => true,
        },
      );

      await expect(process.abort()).rejects.toThrow(
        "Provider still reports its process as running after abort",
      );
    });
  });
});
