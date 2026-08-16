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

describe("finalized message project path links", () => {
  it("annotates string user prompts with confirmed files only", async () => {
    const content = `Please inspect ${existingPath}, not topics/commits.md.`;
    const message = {
      type: "user",
      message: { role: "user", content },
    } as Record<string, unknown>;

    await augmentProjectPathLinksInMessage(message, options);

    expect(message._projectPathLinks).toEqual([
      { filePath: existingPath, text: existingPath },
    ]);
    expect((message.message as { content: string }).content).toBe(content);
  });

  it("annotates text-block user prompts as one visible body", async () => {
    const message = {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "text", text: `Please inspect ${existingPath}.` },
          { type: "input_image", image_url: "data:image/png;base64,AAAA" },
        ],
      },
    } as Record<string, unknown>;

    await augmentProjectPathLinksInMessage(message, options);

    expect(message._projectPathLinks).toEqual([
      { filePath: existingPath, text: existingPath },
    ]);
  });

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
