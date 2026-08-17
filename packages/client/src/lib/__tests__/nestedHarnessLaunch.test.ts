import { describe, expect, it } from "vitest";
import { nestedHarnessLaunchTarget } from "../nestedHarnessLaunch";

const CHILD = "28dad9a6-9c40-4d90-af7e-84d0ed4db9a4";
const CONTEXT = {
  basePath: "",
  projectId: "proj",
  projectPath: "/local/graehl/yepanywhere",
  sessionId: "9f073ea3-fc47-459e-bf7b-46e04fd5a094",
};

describe("nestedHarnessLaunchTarget", () => {
  it("links a resumed launch to its session in this project", () => {
    expect(
      nestedHarnessLaunchTarget(
        `claude --resume ${CHILD} --print < tasks/intake.md`,
        CONTEXT,
      ),
    ).toEqual({
      sessionId: CHILD,
      href: `/projects/proj/sessions/${CHILD}`,
    });
  });

  it("keeps the relay base path in the link", () => {
    expect(
      nestedHarnessLaunchTarget(`claude --resume ${CHILD} -p go`, {
        ...CONTEXT,
        basePath: "/-/relay/gra",
      })?.href,
    ).toBe(`/-/relay/gra/projects/proj/sessions/${CHILD}`);
  });

  it("has no target for a launch with no session to name", () => {
    expect(
      nestedHarnessLaunchTarget("claude --print < tasks/intake.md", CONTEXT),
    ).toBeUndefined();
    expect(nestedHarnessLaunchTarget("ls -la", CONTEXT)).toBeUndefined();
  });

  it("does not link a session to itself", () => {
    expect(
      nestedHarnessLaunchTarget(
        `claude --resume ${CONTEXT.sessionId} -p go`,
        CONTEXT,
      ),
    ).toBeUndefined();
  });

  it("declines a launch that first moves to another directory", () => {
    expect(
      nestedHarnessLaunchTarget(
        `cd /local/graehl/other && claude --resume ${CHILD} -p go`,
        CONTEXT,
      ),
    ).toBeUndefined();
  });

  it("accepts a cd back to this project's own directory", () => {
    expect(
      nestedHarnessLaunchTarget(
        `cd /local/graehl/yepanywhere/ && claude --resume ${CHILD} -p go`,
        CONTEXT,
      )?.sessionId,
    ).toBe(CHILD);
  });

  it("declines when the project path is unknown", () => {
    expect(
      nestedHarnessLaunchTarget(
        `cd /somewhere && claude --resume ${CHILD} -p x`,
        {
          ...CONTEXT,
          projectPath: null,
        },
      ),
    ).toBeUndefined();
  });
});
