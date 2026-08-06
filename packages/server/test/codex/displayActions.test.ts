import { describe, expect, it } from "vitest";
import { extractCodexCodeModeCalls } from "../../src/codex/codeModeExec.js";
import {
  analyzeCodexCommand,
  type CodexDisplayAction,
  parseCodexCommandActionsOracle,
} from "../../src/codex/displayActions.js";

const THREE_READ_COMMAND =
  "sed -n '130,235p' docs/tactical/165-native-feature-parity-baseline.md && " +
  "sed -n '930,1265p' native/crates/mclone-scene/src/session.rs && " +
  "sed -n '1020,1335p' native/apps/mclone-native-client/src/flat_client_driver.rs";

function actionSignature(action: CodexDisplayAction) {
  switch (action.kind) {
    case "read":
      return {
        kind: action.kind,
        name: action.name,
        path: action.absolutePath ?? action.filePath,
        startLine: action.startLine,
        endLine: action.endLine,
      };
    case "search":
      return {
        kind: action.kind,
        query: action.query,
        path: action.path,
      };
    case "list":
      return { kind: action.kind, path: action.path };
  }
}

describe("analyzeCodexCommand", () => {
  it("extracts a simple read with its line window", () => {
    expect(analyzeCodexCommand("sed -n '12,20p' src/example.ts")).toMatchObject(
      {
        explorationOnly: true,
        actions: [
          {
            kind: "read",
            name: "example.ts",
            filePath: "src/example.ts",
            startLine: 12,
            endLine: 20,
            stripLineNumbers: false,
          },
        ],
      },
    );
  });

  it("extracts the observed three-read sequence in source order", () => {
    const analysis = analyzeCodexCommand(THREE_READ_COMMAND, "/repo");

    expect(analysis?.actions.map(actionSignature)).toEqual([
      {
        kind: "read",
        name: "165-native-feature-parity-baseline.md",
        path: "/repo/docs/tactical/165-native-feature-parity-baseline.md",
        startLine: 130,
        endLine: 235,
      },
      {
        kind: "read",
        name: "session.rs",
        path: "/repo/native/crates/mclone-scene/src/session.rs",
        startLine: 930,
        endLine: 1265,
      },
      {
        kind: "read",
        name: "flat_client_driver.rs",
        path: "/repo/native/apps/mclone-native-client/src/flat_client_driver.rs",
        startLine: 1020,
        endLine: 1335,
      },
    ]);
  });

  it("normalizes a live shell-launcher wrapper to the same actions", () => {
    const wrapped = `/opt/homebrew/bin/bash -lc ${JSON.stringify(THREE_READ_COMMAND)}`;

    expect(
      analyzeCodexCommand(wrapped, "/repo")?.actions.map(actionSignature),
    ).toEqual(
      analyzeCodexCommand(THREE_READ_COMMAND, "/repo")?.actions.map(
        actionSignature,
      ),
    );
  });

  it("derives equivalent actions from 5.5 and 5.6 persisted call shapes", () => {
    const codeModeSource = `
      const r = await tools.exec_command(${JSON.stringify({
        cmd: THREE_READ_COMMAND,
        workdir: "/repo",
      })});
      text(r.output);
    `;
    const nestedCall = extractCodexCodeModeCalls(codeModeSource)[0];
    expect(nestedCall?.toolName).toBe("exec_command");

    const input = nestedCall?.input as
      | { cmd?: unknown; workdir?: unknown }
      | undefined;
    const codeModeAnalysis = analyzeCodexCommand(
      typeof input?.cmd === "string" ? input.cmd : "",
      typeof input?.workdir === "string" ? input.workdir : undefined,
    );
    const functionCallAnalysis = analyzeCodexCommand(
      THREE_READ_COMMAND,
      "/repo",
    );

    expect(codeModeAnalysis?.actions.map(actionSignature)).toEqual(
      functionCallAnalysis?.actions.map(actionSignature),
    );
  });

  it("matches sanitized live commandActions for the observed read sequence", () => {
    const oracle = parseCodexCommandActionsOracle([
      {
        type: "read",
        command:
          "sed -n '130,235p' docs/tactical/165-native-feature-parity-baseline.md",
        name: "165-native-feature-parity-baseline.md",
        path: "/repo/docs/tactical/165-native-feature-parity-baseline.md",
      },
      {
        type: "read",
        command: "sed -n '930,1265p' native/crates/mclone-scene/src/session.rs",
        name: "session.rs",
        path: "/repo/native/crates/mclone-scene/src/session.rs",
      },
      {
        type: "read",
        command:
          "sed -n '1020,1335p' native/apps/mclone-native-client/src/flat_client_driver.rs",
        name: "flat_client_driver.rs",
        path: "/repo/native/apps/mclone-native-client/src/flat_client_driver.rs",
      },
    ]);
    const derived = analyzeCodexCommand(THREE_READ_COMMAND, "/repo");

    expect(oracle?.map(actionSignature)).toEqual(
      derived?.actions.map(actionSignature),
    );
  });

  it("recognizes search and list actions", () => {
    expect(
      analyzeCodexCommand("rg -n 'needle|other' src")?.actions,
    ).toMatchObject([{ kind: "search", query: "needle|other", path: "src" }]);
    expect(analyzeCodexCommand("rg --files packages/server")?.actions).toEqual([
      {
        kind: "list",
        command: "rg --files packages/server",
        path: "packages/server",
      },
    ]);
    expect(analyzeCodexCommand("ls -la")?.actions).toEqual([
      { kind: "list", command: "ls -la" },
    ]);
  });

  it("keeps connectors inside quoted search patterns", () => {
    expect(
      analyzeCodexCommand("rg -n 'left && right; still' src")?.actions,
    ).toMatchObject([
      {
        kind: "search",
        query: "left && right; still",
        path: "src",
      },
    ]);
  });

  it("handles safe semicolon and newline exploration sequences", () => {
    expect(
      analyzeCodexCommand("cat README.md;\nrg -n needle src")?.actions.map(
        (action) => action.kind,
      ),
    ).toEqual(["read", "search"]);
  });

  it.each([
    "cat README.md && git status --short",
    "cat source.txt > target.txt",
    "cat $(resolve-file)",
    'cat "$(resolve-file)"',
    "(cat README.md)",
    "cat README.md || cat FALLBACK.md",
    "cat README.md & cat OTHER.md",
  ])(
    "fails closed for mixed or structurally ambiguous command: %s",
    (command) => {
      expect(analyzeCodexCommand(command)).toBeNull();
    },
  );
});

describe("parseCodexCommandActionsOracle", () => {
  it("supports read, search, and listFiles metadata", () => {
    expect(
      parseCodexCommandActionsOracle([
        {
          type: "read",
          command: "cat README.md",
          name: "README.md",
          path: "/repo/README.md",
        },
        {
          type: "search",
          command: "rg needle src",
          query: "needle",
          path: "/repo/src",
        },
        {
          type: "listFiles",
          command: "rg --files src",
          path: "/repo/src",
        },
      ])?.map((action) => action.kind),
    ).toEqual(["read", "search", "list"]);
  });

  it("fails closed when any provider action is unknown", () => {
    expect(
      parseCodexCommandActionsOracle([
        { type: "read", command: "cat README.md", path: "/repo/README.md" },
        { type: "unknown", command: "git status" },
      ]),
    ).toBeNull();
  });
});
