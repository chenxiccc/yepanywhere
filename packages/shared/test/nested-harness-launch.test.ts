import { describe, expect, it } from "vitest";
import { detectNestedHarnessLaunch } from "../src/nested-harness-launch.js";

const CHILD = "28dad9a6-9c40-4d90-af7e-84d0ed4db9a4";

describe("detectNestedHarnessLaunch", () => {
  it("reads the resumed session from a backgrounded launch", () => {
    // Recorded shape from a real launcher transcript.
    expect(
      detectNestedHarnessLaunch(
        `claude --resume ${CHILD} --model claude-opus-5 --permission-mode acceptEdits --allowedTools Read Edit Write Bash Grep Glob --print --output-format stream-json --verbose < tasks/opus-v2-intake-tests.md`,
      ),
    ).toEqual({ harness: "claude", sessionId: CHILD });
  });

  it("accepts the short and attached spellings of the session flags", () => {
    for (const command of [
      `claude -p hi -r ${CHILD}`,
      `claude --resume=${CHILD} --print`,
      `claude --session-id ${CHILD} --print`,
    ]) {
      expect(detectNestedHarnessLaunch(command)).toMatchObject({
        sessionId: CHILD,
      });
    }
  });

  it("normalizes an uppercase session id", () => {
    expect(
      detectNestedHarnessLaunch(`claude --resume ${CHILD.toUpperCase()} -p x`),
    ).toEqual({ harness: "claude", sessionId: CHILD });
  });

  it("reports a fresh non-interactive launch with no session to link", () => {
    expect(
      detectNestedHarnessLaunch(
        "claude --model claude-opus-5 --print < tasks/opus-v2-stage1-contract.md",
      ),
    ).toEqual({ harness: "claude" });
  });

  it("finds the harness behind an environment prefix or wrapper", () => {
    expect(
      detectNestedHarnessLaunch(
        `nohup env FOO=1 claude --resume ${CHILD} -p x`,
      ),
    ).toMatchObject({ sessionId: CHILD });
    expect(
      detectNestedHarnessLaunch(`/home/graehl/.claude/local/claude -p hi`),
    ).toEqual({ harness: "claude" });
  });

  it("reports the directory an earlier cd moved to", () => {
    expect(
      detectNestedHarnessLaunch(
        `cd /local/graehl/other && claude --resume ${CHILD} -p go`,
      ),
    ).toEqual({
      harness: "claude",
      sessionId: CHILD,
      workingDirectory: "/local/graehl/other",
    });
  });

  it("ignores an interactive or informational invocation", () => {
    expect(detectNestedHarnessLaunch("claude --version")).toBeUndefined();
    expect(
      detectNestedHarnessLaunch("claude --help | rg -n 'resume|print'"),
    ).toBeUndefined();
    expect(detectNestedHarnessLaunch("claude")).toBeUndefined();
  });

  it("ignores a --resume whose value is not a session id", () => {
    expect(detectNestedHarnessLaunch("claude --resume")).toBeUndefined();
    expect(detectNestedHarnessLaunch("claude --resume latest")).toBeUndefined();
  });

  it("ignores the harness appearing as an argument, path, or match", () => {
    for (const command of [
      "command -v claude || true; node -p 'require.resolve(\"x\")'",
      "which claude; claude --version 2>/dev/null",
      "rg -n 'claude --resume' packages/server/src --print",
      "git show -s --format='%H' 842dd0da; stat --printf='%y' packages/server/src/sdk/providers/claude-gateway.ts",
    ]) {
      expect(detectNestedHarnessLaunch(command)).toBeUndefined();
    }
  });

  it("does not read a command quoted inside a heredoc body", () => {
    // Observed false positive: a commit message describing the very feature.
    const command = [
      "git commit -q -F - <<'EOF'",
      "Link a backgrounded launch to its session",
      "",
      `A session started by claude --resume ${CHILD} --print is shown nowhere.`,
      "EOF",
      "git --no-pager log --oneline -1",
    ].join("\n");
    expect(detectNestedHarnessLaunch(command)).toBeUndefined();
  });

  it("still reads a launch after a heredoc closes", () => {
    const command = [
      "cat > task.md <<-EOF",
      "\tdo the thing",
      "\tEOF",
      `claude --resume ${CHILD} --print < task.md`,
    ].join("\n");
    expect(detectNestedHarnessLaunch(command)).toMatchObject({
      sessionId: CHILD,
    });
  });

  it("keeps a descriptor duplication out of the argument scan", () => {
    expect(
      detectNestedHarnessLaunch(
        `claude -p go 2>&1 --resume ${CHILD} > /tmp/out.log`,
      ),
    ).toMatchObject({ sessionId: CHILD });
  });

  it("joins a line continuation into one invocation", () => {
    expect(
      detectNestedHarnessLaunch(`claude --print \\\n  --resume ${CHILD}`),
    ).toMatchObject({ sessionId: CHILD });
  });

  it("does not descend into a quoted shell argument", () => {
    expect(
      detectNestedHarnessLaunch(`bash -lc 'claude --resume ${CHILD} --print'`),
    ).toBeUndefined();
  });
});
