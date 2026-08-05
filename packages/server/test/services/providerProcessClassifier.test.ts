import { describe, expect, it } from "vitest";
import { classifyProviderProcess } from "../../src/services/providerProcessClassifier.js";

describe("classifyProviderProcess", () => {
  it("classifies only direct executables and generic runtime entrypoints", () => {
    expect(classifyProviderProcess("codex", ["codex"])).toBe("codex");
    expect(
      classifyProviderProcess("MainThread", [
        "node",
        "/packages/@anthropic-ai/claude-code/cli.js",
      ]),
    ).toBe("claude");
    expect(classifyProviderProcess("bash", ["bash", "codex"])).toBeUndefined();
    expect(
      classifyProviderProcess("python3", ["python3", "my-codex-report.py"]),
    ).toBeUndefined();
  });

  it("recognizes Windows executable names and the gemini-cli alias", () => {
    expect(classifyProviderProcess("Claude.exe", [])).toBe("claude");
    expect(classifyProviderProcess("gemini-cli", ["gemini-cli"])).toBe(
      "gemini",
    );
    expect(
      classifyProviderProcess("MainThread", [
        "node.exe",
        "C:\\npm\\node_modules\\@google\\gemini-cli\\index.js",
      ]),
    ).toBe("gemini");
  });

  it("does not classify a provider name past the entrypoint window", () => {
    // A prompt or a path argument is not an entrypoint, and treating it as one
    // is how an unrelated process gets reported as a running agent.
    expect(
      classifyProviderProcess("node", [
        "node",
        "./build.js",
        "--out",
        "dist",
        "codex",
      ]),
    ).toBeUndefined();
    expect(
      classifyProviderProcess("node", ["node", "./run.js", "ask claude about"]),
    ).toBeUndefined();
  });
});
