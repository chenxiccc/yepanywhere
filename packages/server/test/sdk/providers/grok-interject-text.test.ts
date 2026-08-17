import { describe, expect, it } from "vitest";
import {
  grokInterjectAccepted,
  unwrapGrokInterjectText,
} from "../../../src/sdk/providers/grok-interject-text.js";

const WRAP_PREFIX =
  "The user sent a message while you were working:\n<user_query>\n";
const WRAP_SUFFIX =
  "\n</user_query>\nMake sure to complete any unfinished tasks from previous turns.";

function wrap(inner: string): string {
  return `${WRAP_PREFIX}${inner}${WRAP_SUFFIX}`;
}

describe("unwrapGrokInterjectText", () => {
  it("returns ordinary user text unchanged", () => {
    expect(unwrapGrokInterjectText("just a normal steer")).toBe(
      "just a normal steer",
    );
  });

  it("strips the outer Grok interject envelope", () => {
    expect(unwrapGrokInterjectText(wrap("stop and fix the test"))).toBe(
      "stop and fix the test",
    );
  });

  it("keeps quoted inner user_query markup from the user's text", () => {
    const inner = [
      "show only what is inside the user_query tags ",
      "'The user sent a message while you were working:",
      "<user_query>",
      "quoted example",
      "</user_query>",
      "Make sure to complete any unfinished tasks from previous turns.'",
    ].join("\n");
    expect(unwrapGrokInterjectText(wrap(inner))).toBe(inner);
  });

  it("leaves a partial envelope alone", () => {
    const partial = `${WRAP_PREFIX}still typing`;
    expect(unwrapGrokInterjectText(partial)).toBe(partial);
  });
});

describe("grokInterjectAccepted", () => {
  it("accepts Grok's ExtMethodResult envelope", () => {
    expect(grokInterjectAccepted({ result: { status: "queued" } })).toBe(true);
  });

  it("accepts a bare status payload", () => {
    expect(grokInterjectAccepted({ status: "queued" })).toBe(true);
  });

  it("rejects failures and unknown shapes", () => {
    expect(grokInterjectAccepted({ result: null, error: "no session" })).toBe(
      false,
    );
    expect(grokInterjectAccepted({ result: { status: "ok" } })).toBe(false);
    expect(grokInterjectAccepted({})).toBe(false);
    expect(grokInterjectAccepted(undefined)).toBe(false);
  });
});
