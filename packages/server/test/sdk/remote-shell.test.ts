import { describe, expect, it } from "vitest";
import { quoteRemotePath } from "../../src/sdk/remote-shell.js";
import { buildRsyncArgs } from "../../src/sdk/session-sync.js";

// Word-level quoting cases live with the canonical owner in
// test/utils/posixShell.test.ts.
describe("remote shell quoting", () => {
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
