import { describe, expect, it } from "vitest";
import {
  buildPiLaunchArgs,
  resolvePiLaunchTarget,
  selectPiLaunchTarget,
} from "../../../src/sdk/providers/pi-launch-target.js";

const NODE = "C:\\Program Files\\nodejs\\node.exe";
const GLOBAL_SHIM = "C:\\npm\\pi";
const GLOBAL_CMD_SHIM = "C:\\npm\\pi.cmd";
const GLOBAL_ENTRY =
  "C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js";
const LOCAL_CMD_SHIM = "C:\\repo\\node_modules\\.bin\\pi.cmd";
const LOCAL_ENTRY =
  "C:\\repo\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\cli.js";

function fakeFs(...existing: string[]): (path: string) => boolean {
  const paths = new Set(existing);
  return (path) => paths.has(path);
}

describe("Pi launch target selection", () => {
  it("resolves Windows npm global shims to the package JavaScript entry", () => {
    const target = selectPiLaunchTarget(
      `${GLOBAL_SHIM}\r\n${GLOBAL_CMD_SHIM}\r\n`,
      "win32",
      fakeFs(GLOBAL_SHIM, GLOBAL_CMD_SHIM, GLOBAL_ENTRY),
      NODE,
    );

    expect(target).toEqual({
      command: NODE,
      argsPrefix: [GLOBAL_ENTRY],
      sourcePath: GLOBAL_SHIM,
    });
    expect(buildPiLaunchArgs(target!, ["--version"])).toEqual([
      GLOBAL_ENTRY,
      "--version",
    ]);
  });

  it("resolves project-local node_modules .bin shims", () => {
    expect(
      resolvePiLaunchTarget(
        LOCAL_CMD_SHIM,
        "win32",
        fakeFs(LOCAL_CMD_SHIM, LOCAL_ENTRY),
        NODE,
      ),
    ).toEqual({
      command: NODE,
      argsPrefix: [LOCAL_ENTRY],
      sourcePath: LOCAL_CMD_SHIM,
    });
  });

  it("prefers a directly executable Windows candidate", () => {
    const executable = "C:\\tools\\pi.exe";

    expect(
      selectPiLaunchTarget(
        `${GLOBAL_SHIM}\r\n${executable}\r\n`,
        "win32",
        fakeFs(GLOBAL_SHIM, GLOBAL_ENTRY, executable),
        NODE,
      ),
    ).toEqual({
      command: executable,
      argsPrefix: [],
      sourcePath: executable,
    });
  });

  it("runs an explicit JavaScript entry through Node", () => {
    expect(
      resolvePiLaunchTarget(GLOBAL_ENTRY, "win32", fakeFs(GLOBAL_ENTRY), NODE),
    ).toEqual({
      command: NODE,
      argsPrefix: [GLOBAL_ENTRY],
      sourcePath: GLOBAL_ENTRY,
    });
  });

  it("fails closed for an unresolvable Windows shim", () => {
    expect(
      resolvePiLaunchTarget(
        GLOBAL_CMD_SHIM,
        "win32",
        fakeFs(GLOBAL_CMD_SHIM),
        NODE,
      ),
    ).toBeNull();
  });

  it("skips stale lookup hits before resolving a later npm shim", () => {
    expect(
      selectPiLaunchTarget(
        `C:\\stale\\pi\r\n${GLOBAL_CMD_SHIM}\r\n`,
        "win32",
        fakeFs(GLOBAL_CMD_SHIM, GLOBAL_ENTRY),
        NODE,
      ),
    ).toEqual({
      command: NODE,
      argsPrefix: [GLOBAL_ENTRY],
      sourcePath: GLOBAL_CMD_SHIM,
    });
  });

  it("keeps the first existing POSIX command directly executable", () => {
    const command = "/usr/local/bin/pi";

    expect(
      selectPiLaunchTarget(
        `/stale/pi\n${command}\n`,
        "linux",
        fakeFs(command),
        "/usr/bin/node",
      ),
    ).toEqual({ command, argsPrefix: [], sourcePath: command });
  });
});
