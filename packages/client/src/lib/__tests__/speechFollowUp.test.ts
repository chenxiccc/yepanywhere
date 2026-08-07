import { afterEach, describe, expect, it, vi } from "vitest";
import {
  armSpeechFollowUp,
  cancelSpeechFollowUp,
  claimSpeechFollowUp,
  getSpeechFollowUpSnapshot,
  noteSpeechFollowUpActivity,
  releaseSpeechFollowUpOwner,
} from "../speechFollowUp";

describe("speechFollowUp", () => {
  afterEach(() => {
    cancelSpeechFollowUp();
    vi.useRealTimers();
  });

  it("expires an idle follow-up and runs its cleanup", () => {
    vi.useFakeTimers();
    const owner = {};
    const cleanup = vi.fn();

    armSpeechFollowUp(3_000, owner, cleanup);
    vi.advanceTimersByTime(2_999);
    expect(getSpeechFollowUpSnapshot().active).toBe(true);
    vi.advanceTimersByTime(1);

    expect(getSpeechFollowUpSnapshot().active).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();
  });

  it("lets a new composer claim the window after navigation", () => {
    const firstOwner = {};
    const nextOwner = {};
    const nextCleanup = vi.fn();

    armSpeechFollowUp(3_000, firstOwner, vi.fn());
    releaseSpeechFollowUpOwner(firstOwner);

    expect(claimSpeechFollowUp(nextOwner, nextCleanup)).toBe(true);
    expect(getSpeechFollowUpSnapshot().owner).toBe(nextOwner);
  });

  it("expires without cutting off speech that began before the deadline", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const owner = {};
    const cleanup = vi.fn();

    armSpeechFollowUp(3_000, owner, cleanup);
    noteSpeechFollowUpActivity(owner);
    vi.advanceTimersByTime(30_000);

    expect(getSpeechFollowUpSnapshot()).toMatchObject({
      active: true,
      deadlineMs: 13_000,
      expired: true,
      speechStarted: true,
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it("does not move the absolute deadline when speech begins", () => {
    vi.useFakeTimers();
    vi.setSystemTime(20_000);
    const owner = {};

    armSpeechFollowUp(3_000, owner, vi.fn());
    vi.advanceTimersByTime(2_000);
    noteSpeechFollowUpActivity(owner);

    expect(getSpeechFollowUpSnapshot()).toMatchObject({
      active: true,
      deadlineMs: 23_000,
      expired: false,
      speechStarted: true,
    });
  });
});
