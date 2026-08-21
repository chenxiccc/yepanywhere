import { describe, expect, it } from "vitest";
import { quoteShellWord } from "../../src/utils/posixShell.js";

// Canonical tests for the single POSIX shell-word quoting owner shared by
// remote launch commands, Claude login command formatting, and agentctl
// session-environment publication.
describe("quoteShellWord", () => {
  it.each([
    ["", "''"],
    ["plain", "'plain'"],
    ["a'b", "'a'\\''b'"],
    ['a"b', `'a"b'`],
    ["$(touch nope)", "'$(touch nope)'"],
    ["`touch nope`", "'`touch nope`'"],
    ["line one\nline two", "'line one\nline two'"],
    ["-leading-option", "'-leading-option'"],
    ["ends with quote'", "'ends with quote'\\'''"],
    ["''", "''\\'''\\'''"],
  ])("quotes %j as one literal word", (value, expected) => {
    expect(quoteShellWord(value)).toBe(expected);
  });
});
