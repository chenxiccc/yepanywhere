// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  resetSpeechCaptureActivityForTests,
  setSpeechCaptureActivity,
} from "../speechCaptureActivity";

describe("speechCaptureActivity", () => {
  afterEach(() => {
    resetSpeechCaptureActivityForTests();
    document.body.replaceChildren();
  });

  it("mutes YA media during capture and restores each prior state", () => {
    const unmuted = document.createElement("audio");
    const alreadyMuted = document.createElement("video");
    alreadyMuted.muted = true;
    document.body.append(unmuted, alreadyMuted);
    const owner = {};

    setSpeechCaptureActivity(owner, "starting");

    expect(document.documentElement.dataset.speechCapture).toBe("starting");
    expect(unmuted.muted).toBe(true);
    expect(alreadyMuted.muted).toBe(true);

    setSpeechCaptureActivity(owner, "capturing");
    expect(document.documentElement.dataset.speechCapture).toBe("capturing");

    setSpeechCaptureActivity(owner, null);
    expect(document.documentElement.dataset.speechCapture).toBeUndefined();
    expect(unmuted.muted).toBe(false);
    expect(alreadyMuted.muted).toBe(true);
  });

  it("mutes media inserted after capture begins", async () => {
    const owner = {};
    setSpeechCaptureActivity(owner, "capturing");

    const added = document.createElement("video");
    document.body.append(added);
    await Promise.resolve();

    expect(added.muted).toBe(true);
    setSpeechCaptureActivity(owner, null);
    expect(added.muted).toBe(false);
  });

  it("does not restore media until every capture owner is idle", () => {
    const media = document.createElement("audio");
    document.body.append(media);
    const firstOwner = {};
    const secondOwner = {};

    setSpeechCaptureActivity(firstOwner, "starting");
    setSpeechCaptureActivity(secondOwner, "capturing");
    setSpeechCaptureActivity(secondOwner, null);

    expect(media.muted).toBe(true);
    expect(document.documentElement.dataset.speechCapture).toBe("starting");

    setSpeechCaptureActivity(firstOwner, null);
    expect(media.muted).toBe(false);
  });
});
