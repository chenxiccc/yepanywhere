import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_STEER_BACKGROUND_BASH,
  createClaudeSteerBackgroundBashMatcher,
  parseClaudeSteerBackgroundBashSettings,
} from "../src/claude-steering.js";

describe("Claude steer Bash background policy", () => {
  it("allows every whole command by default, including multiline commands", () => {
    const matches = createClaudeSteerBackgroundBashMatcher(
      DEFAULT_CLAUDE_STEER_BACKGROUND_BASH,
    );

    expect(matches("sleep 30")).toBe(true);
    expect(matches("printf start\nsleep 30")).toBe(true);
  });

  it("matches the whole command and gives deny precedence", () => {
    const matches = createClaudeSteerBackgroundBashMatcher({
      allowRegex: "(?:sleep|watch) [0-9]+",
      denyRegex: "sleep 5",
    });

    expect(matches("sleep 30")).toBe(true);
    expect(matches("prefix sleep 30")).toBe(false);
    expect(matches("sleep 30\n")).toBe(false);
    expect(matches("sleep 5")).toBe(false);
  });

  it("treats an empty allow as disabled and an empty deny as deny-nothing", () => {
    expect(
      createClaudeSteerBackgroundBashMatcher({
        allowRegex: "",
        denyRegex: "",
      })("sleep 30"),
    ).toBe(false);
    expect(
      createClaudeSteerBackgroundBashMatcher({
        allowRegex: ".*",
        denyRegex: "",
      })("sleep 30"),
    ).toBe(true);
  });

  it("rejects unknown keys and invalid expressions", () => {
    expect(
      parseClaudeSteerBackgroundBashSettings({
        allowRegex: "[",
        denyRegex: "",
      }),
    ).toBeNull();
    expect(
      parseClaudeSteerBackgroundBashSettings({
        allowRegex: ".*",
        denyRegex: "",
        extra: true,
      }),
    ).toBeNull();
    expect(
      parseClaudeSteerBackgroundBashSettings({
        allowRegex: "(?=unsafe)",
        denyRegex: "",
      }),
    ).toBeNull();
    expect(
      parseClaudeSteerBackgroundBashSettings({
        allowRegex: "(unsafe)\\1",
        denyRegex: "",
      }),
    ).toBeNull();
  });

  it("fails closed when invalid settings bypass parsing", () => {
    const matches = createClaudeSteerBackgroundBashMatcher({
      allowRegex: "[",
      denyRegex: "",
    });

    expect(matches("sleep 30")).toBe(false);
  });

  it("evaluates nested quantifiers without catastrophic backtracking", () => {
    const matches = createClaudeSteerBackgroundBashMatcher({
      allowRegex: "^(a+)+$",
      denyRegex: "",
    });
    const longPrefix = "a".repeat(10_000);

    expect(matches(longPrefix)).toBe(true);
    expect(matches(`${longPrefix}!`)).toBe(false);
  });

  it("fails closed for commands beyond the bounded matching input", () => {
    const matches = createClaudeSteerBackgroundBashMatcher({
      allowRegex: ".*",
      denyRegex: "",
    });

    expect(matches("x".repeat(16 * 1024 + 1))).toBe(false);
  });
});
