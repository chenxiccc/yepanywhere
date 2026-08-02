import { describe, expect, it, vi } from "vitest";
import { ReviewResponseObserver } from "../../src/review/ReviewResponseObserver.js";

describe("ReviewResponseObserver", () => {
  it("checks once after each completed assistant activity", async () => {
    const observeAssistantTurn = vi.fn().mockResolvedValue([]);
    const observer = new ReviewResponseObserver({
      observeAssistantTurn,
    } as never);
    const process = {
      id: "process-1",
      sessionId: "session-1",
      projectPath: "/project",
      assistantActivityVersion: 0,
    };

    await expect(observer.observeIdle(process)).resolves.toBeNull();
    process.assistantActivityVersion = 1;
    await expect(observer.observeIdle(process)).resolves.toEqual([]);
    await expect(observer.observeIdle(process)).resolves.toBeNull();
    process.assistantActivityVersion = 2;
    await expect(observer.observeIdle(process)).resolves.toEqual([]);
    expect(observeAssistantTurn).toHaveBeenCalledTimes(2);
    expect(observeAssistantTurn).toHaveBeenLastCalledWith(
      "/project",
      "session-1",
    );
  });

  it("retries a failed activity version and forgets terminated processes", async () => {
    const observeAssistantTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("disk busy"))
      .mockResolvedValue([]);
    const observer = new ReviewResponseObserver({
      observeAssistantTurn,
    } as never);
    const process = {
      id: "process-1",
      sessionId: "session-1",
      projectPath: "/project",
      assistantActivityVersion: 1,
    };

    await expect(observer.observeIdle(process)).rejects.toThrow("disk busy");
    await expect(observer.observeIdle(process)).resolves.toEqual([]);
    observer.forget(process.id);
    await expect(observer.observeIdle(process)).resolves.toEqual([]);
  });
});
