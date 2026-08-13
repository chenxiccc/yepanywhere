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
