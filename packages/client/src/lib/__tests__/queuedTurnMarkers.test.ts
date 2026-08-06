import { describe, expect, it } from "vitest";
import { parseUserPrompt } from "../parseUserPrompt";
import { stripQueuedTurnMarkers } from "../queuedTurnMarkers";

describe("stripQueuedTurnMarkers", () => {
  it("strips a legacy leading time marker", () => {
    expect(stripQueuedTurnMarkers("(343s ago)\n\nreal message")).toBe(
      "real message",
    );
    expect(stripQueuedTurnMarkers("--- (13s later)\n\nreal message")).toBe(
      "real message",
    );
  });

  it("strips a needle-bearing anchor", () => {
    expect(
      stripQueuedTurnMarkers(
        '(525s ago, had seen: "…tail of the streamed text")\n\nreal message',
      ),
    ).toBe("real message");
  });

  it("strips leading and trailing turn timestamps", () => {
    expect(
      stripQueuedTurnMarkers("[sent 2026-08-06T06:40:12.123Z]\n\nmessage"),
    ).toBe("message");
    expect(
      stripQueuedTurnMarkers("message\n\n[sent 2026-08-06T06:40:12.123Z]"),
    ).toBe("message");
  });

  it("strips an anchor plus a before-placement timestamp together", () => {
    expect(
      stripQueuedTurnMarkers(
        "(45s ago)\n\n[sent 2026-08-06T06:40:12.123Z]\n\nmessage",
      ),
    ).toBe("message");
  });

  it("strips the needle-only anchor form used alongside turn stamps", () => {
    expect(
      stripQueuedTurnMarkers(
        '(had seen: "tail text")\n\n[sent 2026-08-06T06:40:12.123Z]\n\nmessage',
      ),
    ).toBe("message");
  });

  it("leaves plain text alone", () => {
    expect(stripQueuedTurnMarkers("just a (normal) message")).toBe(
      "just a (normal) message",
    );
  });
});

describe("parseUserPrompt marker hiding", () => {
  it("hides queued-turn markers from display text", () => {
    expect(
      parseUserPrompt('(45s ago, had seen: "context tail")\n\nhello').text,
    ).toBe("hello");
    expect(
      parseUserPrompt("hello\n\n[sent 2026-08-06T06:40:12.123Z]").text,
    ).toBe("hello");
  });
});
