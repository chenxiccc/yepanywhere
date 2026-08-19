import { MARKDOWN_LIKE_FILE_EXTENSIONS } from "@yep-anywhere/shared";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildGitDiffResult } from "../../src/git/diffResult.js";

describe("buildGitDiffResult", () => {
  it.each([...MARKDOWN_LIKE_FILE_EXTENSIONS])(
    "renders Markdown preview HTML for .%s diffs",
    async (extension) => {
      const result = await buildGitDiffResult({
        path: `notes/report.${extension}`,
        oldContent: "# Old\n",
        newContent: "# New\n",
      });

      expect(result.markdownHtml).toContain("<h1>New</h1>");
    },
  );

  it("does not render Markdown preview HTML for other text files", async () => {
    const result = await buildGitDiffResult({
      path: "notes/report.txt",
      oldContent: "Old\n",
      newContent: "New\n",
    });

    expect(result.markdownHtml).toBeUndefined();
  });

  it("returns a large useful diff without syntax-highlighted expansion", async () => {
    const lines = Array.from(
      { length: 19_800 },
      (_, index) => `{"index":${index},"value":"record ${index}"}`,
    );
    const result = await buildGitDiffResult({
      path: "evidence.json",
      oldContent: "",
      newContent: lines.join("\n"),
    });

    expect(result.previewSkipped).toBeUndefined();
    expect(result.diffHtml).toBe("");
    expect(result.renderMode).toBe("plain");
    expect(result.structuredPatch[0]?.lines).toHaveLength(19_800);
  });

  it("renders a 5,000-line multi-megabyte diff in plain mode", async () => {
    const result = await buildGitDiffResult({
      path: "generated.txt",
      oldContent: "",
      newContent: Array.from(
        { length: 5_000 },
        (_, index) => `${index}: ${"x".repeat(2_048)}`,
      ).join("\n"),
    });

    expect(result.previewSkipped).toBeUndefined();
    expect(result.diffHtml).toBe("");
    expect(result.renderMode).toBe("plain");
    expect(result.structuredPatch[0]?.lines).toHaveLength(5_000);
  });

  it("skips a plain diff above the browser line budget", async () => {
    const result = await buildGitDiffResult({
      path: "many-lines.txt",
      oldContent: "",
      newContent: Array.from({ length: 20_001 }, () => "x").join("\n"),
    });

    expect(result.previewSkipped).toMatchObject({
      reason: "content-too-large",
      totalLines: 20_001,
      maxTotalLines: 20_000,
    });
  });

  it("skips a plain diff above the browser character budget", async () => {
    const result = await buildGitDiffResult({
      path: "wide-lines.txt",
      oldContent: "",
      newContent: Array.from({ length: 1_000 }, () => "x".repeat(17_000)).join(
        "\n",
      ),
    });

    expect(result.previewSkipped).toMatchObject({
      reason: "content-too-large",
      maxTotalChars: 16_777_216,
      maxTotalLines: 20_000,
    });
    expect(result.previewSkipped?.totalChars).toBeGreaterThan(16_777_216);
  });

  it("resolves Quarto includes through the selected project", async () => {
    const projectPath = await mkdtemp(join(tmpdir(), "ya-qmd-diff-"));
    try {
      await mkdir(join(projectPath, "notes", "sections"), { recursive: true });
      await writeFile(
        join(projectPath, "notes", "sections", "_methods.qmd"),
        "Methods\n",
      );

      const result = await buildGitDiffResult({
        path: "notes/report.qmd",
        oldContent: "# Old\n",
        newContent: "{{< include sections/_methods.qmd >}}\n",
        markdownProject: { id: "project-1", path: projectPath },
      });

      expect(result.markdownHtml).toContain(
        'href="/projects/project-1/file?path=notes%2Fsections%2F_methods.qmd"',
      );
      expect(result.markdownHtml).toContain('data-ya-resource="project-file"');
    } finally {
      await rm(projectPath, { recursive: true });
    }
  });
});
