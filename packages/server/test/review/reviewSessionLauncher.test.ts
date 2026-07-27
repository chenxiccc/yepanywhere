import { describe, expect, it, vi } from "vitest";
import { createSupervisorReviewLauncher } from "../../src/review/reviewSessionLauncher.js";
import type { Supervisor } from "../../src/supervisor/Supervisor.js";

describe("createSupervisorReviewLauncher.startReviewSession", () => {
  it("starts with the origin session's provider, model, thinking, and effort", async () => {
    const startSession = vi.fn(async () => ({ sessionId: "new-session" }));
    const supervisor = { startSession } as unknown as Supervisor;

    const result = await createSupervisorReviewLauncher(
      supervisor,
    ).startReviewSession("/repo", "turn", {
      provider: "codex",
      model: "gpt-5.4",
      thinking: { type: "adaptive", display: "summarized" },
      effort: "high",
    });

    expect(result).toEqual({ status: "started", sessionId: "new-session" });
    expect(startSession).toHaveBeenCalledWith(
      "/repo",
      { text: "turn" },
      undefined,
      {
        providerName: "codex",
        model: "gpt-5.4",
        thinking: { type: "adaptive", display: "summarized" },
        effort: "high",
      },
    );
  });
});

describe("createSupervisorReviewLauncher.deliverFollowUp", () => {
  it("queues the turn to a live process without resuming", async () => {
    const queueMessage = vi.fn();
    const resumeSession = vi.fn();
    const supervisor = {
      getProcessForSession: () => ({ queueMessage }),
      resumeSession,
    } as unknown as Supervisor;

    const result = await createSupervisorReviewLauncher(
      supervisor,
    ).deliverFollowUp("/repo", "sess", "turn");

    expect(result).toEqual({ status: "delivered" });
    expect(queueMessage).toHaveBeenCalledWith({ text: "turn" });
    expect(resumeSession).not.toHaveBeenCalled();
  });

  it("resumes a reaped session (no live process) and delivers the turn", async () => {
    // resumeSession resolves to a Process-like value (no error/queued fields).
    const resumeSession = vi.fn(async () => ({}));
    const supervisor = {
      getProcessForSession: () => undefined,
      resumeSession,
    } as unknown as Supervisor;

    const result = await createSupervisorReviewLauncher(
      supervisor,
    ).deliverFollowUp("/repo", "dead-sess", "turn");

    expect(result).toEqual({ status: "delivered" });
    expect(resumeSession).toHaveBeenCalledWith("dead-sess", "/repo", {
      text: "turn",
    });
  });

  it("propagates queued and queue-full from a resume at capacity", async () => {
    const queued = {
      getProcessForSession: () => undefined,
      resumeSession: async () => ({ queued: true, queueId: "q", position: 1 }),
    } as unknown as Supervisor;
    expect(
      await createSupervisorReviewLauncher(queued).deliverFollowUp(
        "/r",
        "s",
        "t",
      ),
    ).toEqual({ status: "queued" });

    const full = {
      getProcessForSession: () => undefined,
      resumeSession: async () => ({ error: "queue_full", maxQueueSize: 5 }),
    } as unknown as Supervisor;
    expect(
      await createSupervisorReviewLauncher(full).deliverFollowUp(
        "/r",
        "s",
        "t",
      ),
    ).toEqual({ status: "queue-full", maxQueueSize: 5 });
  });
});
