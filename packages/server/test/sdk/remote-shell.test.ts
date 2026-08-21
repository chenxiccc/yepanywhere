import { describe, expect, it } from "vitest";
import { quoteRemotePath, quoteShellWord } from "../../src/sdk/remote-shell.js";
import { buildRsyncArgs } from "../../src/sdk/session-sync.js";

describe("remote shell quoting", () => {
  it.each([
    ["", "''"],
    ["plain", "'plain'"],
    ["a'b", "'a'\\''b'"],
    ['a"b', `'a"b'`],
    ["$(touch nope)", "'$(touch nope)'"],
    ["`touch nope`", "'`touch nope`'"],
    ["line one\nline two", "'line one\nline two'"],
    ["-leading-option", "'-leading-option'"],
  ])("quotes %j as one literal word", (value, expected) => {
    expect(quoteShellWord(value)).toBe(expected);
  });

  it("expands only a leading $HOME token", () => {
    expect(quoteRemotePath("$HOME/project's/$(touch nope)\n-next")).toBe(
      "\"$HOME\"'/project'\\''s/$(touch nope)\n-next'",
    );
    expect(quoteRemotePath("/srv/$HOME/project")).toBe("'/srv/$HOME/project'");
  });

  it("uses rsync's protected argument channel without shell quoting paths", () => {
    const source =
      "remote:/home/user/-leading 'quote' $(touch nope) `touch nope`\nline/";
    const dest = "/local/path/";

    expect(buildRsyncArgs(source, dest)).toEqual([
      "-az",
      "--protect-args",
      "-e",
      "ssh -o BatchMode=yes",
      "--",
      source,
      dest,
    ]);
  });
});
