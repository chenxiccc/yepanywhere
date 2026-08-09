import { describe, expect, it } from "vitest";
import { parseSessionMetadataPatch } from "../../src/routes/session-metadata-patch.js";

describe("parseSessionMetadataPatch", () => {
  it("rejects empty metadata patches", () => {
    expect(parseSessionMetadataPatch({})).toEqual({
      ok: false,
      status: 400,
      error: "At least one session metadata field must be provided",
    });
  });

  it("normalizes parent, heartbeat, prompt suggestion, and recap fields", () => {
    const result = parseSessionMetadataPatch({
      title: "Session title",
      archived: true,
      starred: false,
      parentSessionId: " parent ",
      heartbeatTurnsEnabled: true,
      wakeTurnsEnabled: false,
      heartbeatTurnsAfterMinutes: 0,
      heartbeatTurnText: "x".repeat(250),
      heartbeatForceAfterMinutes: 5,
      promptSuggestionMode: "native",
      recapAfterSeconds: 42,
    });

    expect(result).toMatchObject({
      ok: true,
      patch: {
        title: "Session title",
        archived: true,
        starred: false,
        parentSessionId: "parent",
        heartbeatTurnsEnabled: true,
        wakeTurnsEnabled: false,
        heartbeatTurnsAfterMinutes: null,
        heartbeatTurnText: "x".repeat(200),
        heartbeatForceAfterMinutes: 5,
        promptSuggestionMode: "native",
        recapAfterSeconds: 42,
      },
    });
  });

  it("normalizes clear values", () => {
    expect(
      parseSessionMetadataPatch({
        parentSessionId: "",
        wakeTurnsEnabled: null,
        heartbeatTurnsAfterMinutes: null,
        heartbeatTurnText: "",
        heartbeatForceAfterMinutes: 0,
        promptSuggestionMode: "",
        recapAfterSeconds: "",
      }),
    ).toMatchObject({
      ok: true,
      patch: {
        parentSessionId: null,
        wakeTurnsEnabled: null,
        heartbeatTurnsAfterMinutes: null,
        heartbeatTurnText: null,
        heartbeatForceAfterMinutes: null,
        promptSuggestionMode: null,
        recapAfterSeconds: null,
      },
    });
  });

  it("rejects invalid heartbeat intervals", () => {
    expect(
      parseSessionMetadataPatch({ heartbeatTurnsAfterMinutes: 1441 }),
    ).toEqual({
      ok: false,
      status: 400,
      error:
        "heartbeatTurnsAfterMinutes must be null or an integer between 1 and 1440",
    });
    expect(
      parseSessionMetadataPatch({ heartbeatForceAfterMinutes: 1.5 }),
    ).toEqual({
      ok: false,
      status: 400,
      error:
        "heartbeatForceAfterMinutes must be null or an integer between 1 and 1440",
    });
  });

  it("rejects invalid typed fields with route-compatible messages", () => {
    expect(parseSessionMetadataPatch({ heartbeatTurnText: 1 })).toEqual({
      ok: false,
      status: 400,
      error: "heartbeatTurnText must be a string or null",
    });
    expect(parseSessionMetadataPatch({ parentSessionId: 1 })).toEqual({
      ok: false,
      status: 400,
      error: "parentSessionId must be a string or null",
    });
    expect(parseSessionMetadataPatch({ wakeTurnsEnabled: "yes" })).toEqual({
      ok: false,
      status: 400,
      error: "wakeTurnsEnabled must be a boolean or null",
    });
    expect(
      parseSessionMetadataPatch({ promptSuggestionMode: "helper" }),
    ).toEqual({
      ok: false,
      status: 400,
      error: "promptSuggestionMode must be one of: off, native",
    });
    expect(parseSessionMetadataPatch({ recapAfterSeconds: "soon" })).toEqual({
      ok: false,
      status: 400,
      error: "recapAfterSeconds must be null or a finite number",
    });
  });
});
