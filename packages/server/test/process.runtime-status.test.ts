import { describe, expect, it, vi } from "vitest";
import {
  Process,
  createControllableIterator,
  waitFor,
} from "./process.test-support.js";
import type { ProcessEvent, UrlProjectId } from "./process.test-support.js";

describe("Process", () => {
  describe("provider runtime status", () => {
    it("records Claude api_retry status in process info", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
        retry_delay_ms: 60_000,
        attempt: 1,
        max_retries: 2_147_483_647,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      const status = process.getInfo().providerRuntimeStatus;
      expect(status).toMatchObject({
        kind: "retrying",
        provider: "claude",
        reason: "rate_limit",
        httpStatus: 429,
        retryDelayMs: 60_000,
        attempt: 1,
        maxRetries: "unbounded",
        eventCount: 1,
        source: "claude.system.api_retry",
      });
      expect(status?.startedAt).toBe(status?.lastSeenAt);
      const retryDelay =
        Date.parse(status?.retryAt ?? "") -
        Date.parse(status?.lastSeenAt ?? "");
      expect(retryDelay).toBe(60_000);

      controller.finish();
    });

    it("emits provider runtime status changes", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });
      const events: ProcessEvent[] = [];
      process.subscribe((event) => {
        events.push(event);
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(
          events.some(
            (event) =>
              event.type === "provider-runtime-status-change" &&
              event.status?.kind === "retrying",
          ),
        ).toBe(true);
      });

      controller.push({
        type: "assistant",
        message: { role: "assistant", content: "Recovered" },
      });

      await waitFor(() => {
        expect(
          events.some(
            (event) =>
              event.type === "provider-runtime-status-change" &&
              event.status === null,
          ),
        ).toBe(true);
      });

      controller.finish();
    });

    it("updates Claude api_retry status without resetting the incident start", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "init",
        session_id: "sess-1",
      });
      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
        retry_delay_ms: 60_000,
        attempt: 1,
        max_retries: 2_147_483_647,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.eventCount).toBe(1);
      });
      const firstStartedAt = process.getInfo().providerRuntimeStatus?.startedAt;

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 529,
        error: "overloaded",
        retry_delay_ms: 30_000,
        attempt: 2,
        max_retries: 3,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.eventCount).toBe(2);
      });

      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "retrying",
        provider: "claude",
        reason: "overloaded",
        httpStatus: 529,
        retryDelayMs: 30_000,
        attempt: 2,
        maxRetries: 3,
        startedAt: firstStartedAt,
        eventCount: 2,
      });

      controller.finish();
    });

    it("ignores Claude-shaped api_retry messages for non-Claude providers", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
        retry_delay_ms: 60_000,
      });

      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(process.getInfo().providerRuntimeStatus).toBe(null);

      controller.finish();
    });

    it("records terminal Codex errors until the next user turn", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "error",
        uuid: "codex-error-turn-1",
        session_id: "sess-1",
        error: "Selected model is at capacity. Please try a different model.",
        codexErrorInfo: "serverOverloaded",
        codexWillRetry: false,
        codexTurnId: "turn-1",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");
      });
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        provider: "codex",
        reason: "overloaded",
        message: "Selected model is at capacity. Please try a different model.",
        turnId: "turn-1",
        source: "codex.error",
      });

      controller.push({ type: "result", session_id: "sess-1" });
      await waitFor(() => {
        expect(process.state.type).toBe("idle");
      });
      expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");

      controller.push({
        type: "user",
        uuid: "user-2",
        session_id: "sess-1",
        message: { role: "user", content: "Try again" },
      });
      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus).toBe(null);
      });

      controller.finish();
    });

    it("records automatic Codex retries until provider progress resumes", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "error",
        uuid: "codex-error-turn-1",
        session_id: "sess-1",
        error: "Reconnecting... 2/5",
        codexErrorInfo: {
          responseStreamDisconnected: { httpStatusCode: 502 },
        },
        codexAdditionalDetails: "stream disconnected before completion",
        codexWillRetry: true,
        codexTurnId: "turn-1",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "retrying",
        provider: "codex",
        reason: "network",
        httpStatus: 502,
        message: "Reconnecting... 2/5",
        details: "stream disconnected before completion",
        turnId: "turn-1",
        eventCount: 1,
        source: "codex.error",
      });

      controller.push({
        type: "assistant",
        uuid: "assistant-1",
        session_id: "sess-1",
        message: { role: "assistant", content: "Recovered" },
      });
      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus).toBe(null);
      });

      controller.finish();
    });

    it("distinguishes Codex app-server process exits from failed turns", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "error",
        uuid: "codex-error-process-exit",
        session_id: "sess-1",
        error: "Codex app-server exited (code=1, signal=null)",
        codexWillRetry: false,
        codexErrorScope: "app_server_process",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("terminal");
      });
      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        provider: "codex",
        reason: "server_error",
        message: "Codex app-server exited (code=1, signal=null)",
        scope: "provider_process",
        source: "codex.app_server_process",
      });

      controller.finish();
    });

    it("restores a retained terminal status into a reactivated process", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "codex",
        idleTimeoutMs: 100,
        initialProviderRuntimeStatus: {
          kind: "terminal",
          provider: "codex",
          reason: "overloaded",
          message: "Selected model is at capacity.",
          occurredAt: "2026-07-10T18:14:32.213Z",
          source: "codex.error",
          turnId: "turn-1",
        },
      });

      expect(process.getInfo().providerRuntimeStatus).toMatchObject({
        kind: "terminal",
        reason: "overloaded",
        turnId: "turn-1",
      });

      controller.finish();
    });

    it("clears retry status when assistant progress resumes", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      controller.push({
        type: "assistant",
        message: { role: "assistant", content: "Recovered" },
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus).toBe(null);
      });

      controller.finish();
    });

    it("clears retry status when the turn ends", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      controller.push({ type: "result", session_id: "sess-1" });

      await waitFor(() => {
        expect(process.state.type).toBe("idle");
      });
      expect(process.getInfo().providerRuntimeStatus).toBe(null);

      controller.finish();
    });

    it("interrupts a retrying turn when changing models", async () => {
      const controller = createControllableIterator();
      const setModelFn = vi.fn(async () => {});
      const interruptFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        setModelFn,
        interruptFn,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
        retry_delay_ms: 60_000,
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      await expect(process.setModel("opus")).resolves.toBe(true);

      expect(setModelFn).toHaveBeenCalledWith("opus");
      expect(interruptFn).toHaveBeenCalledTimes(1);
      expect(setModelFn.mock.invocationCallOrder[0]).toBeLessThan(
        interruptFn.mock.invocationCallOrder[0] ?? 0,
      );
      expect(process.getInfo().providerRuntimeStatus).toBe(null);
      expect(process.resolvedModel).toBe("opus");

      controller.finish();
    });

    it("does not interrupt if retry progress resumes during a model change", async () => {
      const controller = createControllableIterator();
      let process: Process;
      const setModelFn = vi.fn(async () => {
        controller.push({
          type: "assistant",
          message: { role: "assistant", content: "Recovered" },
        });
        await waitFor(() => {
          expect(process.getInfo().providerRuntimeStatus).toBe(null);
        });
      });
      const interruptFn = vi.fn(async () => true);
      process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        setModelFn,
        interruptFn,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      await expect(process.setModel("opus")).resolves.toBe(true);

      expect(interruptFn).not.toHaveBeenCalled();
      expect(process.resolvedModel).toBe("opus");

      controller.finish();
    });

    it("does not interrupt an ordinary active turn when changing models", async () => {
      const controller = createControllableIterator();
      const setModelFn = vi.fn(async () => {});
      const interruptFn = vi.fn(async () => true);
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
        setModelFn,
        interruptFn,
      });

      await expect(process.setModel("opus")).resolves.toBe(true);

      expect(setModelFn).toHaveBeenCalledWith("opus");
      expect(interruptFn).not.toHaveBeenCalled();

      controller.finish();
    });

    it("clears retry status when aborted", async () => {
      const controller = createControllableIterator();
      const process = new Process(controller.iterator, {
        projectPath: "/test",
        projectId: "proj-1" as UrlProjectId,
        sessionId: "sess-1",
        provider: "claude",
        idleTimeoutMs: 100,
      });

      controller.push({
        type: "system",
        subtype: "api_retry",
        session_id: "sess-1",
        error_status: 429,
        error: "rate_limit",
      });

      await waitFor(() => {
        expect(process.getInfo().providerRuntimeStatus?.kind).toBe("retrying");
      });

      const abortPromise = process.abort();
      expect(process.getInfo().providerRuntimeStatus).toBe(null);
      controller.finish();
      await abortPromise;
    });
  });
});
