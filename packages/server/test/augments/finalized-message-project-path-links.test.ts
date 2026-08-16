import { describe, expect, it } from "vitest";
import { augmentProjectPathLinksInMessage } from "../../src/augments/finalized-message-augmenter.js";
import type { ProjectPathIndex } from "../../src/projects/projectPathIndex.js";

const existingPath = "topics/performance-regression-suite.md";

function pathIndex(): ProjectPathIndex {
  return {
    findExisting: async (paths) =>
      new Set(paths.filter((path) => path === existingPath)),
    has: async (path) => path === existingPath,
    knownFile: (path) => path === existingPath,
    release: () => undefined,
    sourceRevision: () => 1,
  };
}

const options = {
  projectFileLinks: {
    index: pathIndex(),
    projectId: "project-1",
    projectPath: "/repo",
  },
};

describe("finalized tool-text project path links", () => {
  it("annotates Bash command inputs with confirmed files only", async () => {
    const input = {
      command: `cat ${existingPath} topics/commits.md`,
    } as Record<string, unknown>;
    const message = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input }],
      },
    };

    await augmentProjectPathLinksInMessage(message, options);

    expect(input._projectPathLinks).toEqual([
      { filePath: existingPath, text: existingPath },
    ]);
  });

  it("annotates tool-result bodies without changing their text", async () => {
    const output = [
      `228 ${existingPath}`,
      "wc: topics/commits.md: No such file or directory",
    ].join("\n");
    const block = {
      type: "tool_result",
      content: output,
    } as Record<string, unknown>;
    const message = { type: "user", message: { content: [block] } };

    await augmentProjectPathLinksInMessage(message, options);

    expect(block.content).toBe(output);
    expect(block._projectPathLinks).toEqual([
      { filePath: existingPath, text: existingPath },
    ]);
  });
});
