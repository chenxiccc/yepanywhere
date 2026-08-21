import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLocalFileRoutes } from "../../src/routes/local-file.js";

describe("Local file routes", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(path.join(os.tmpdir(), "yep-local-file-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("serves Markdown files from allowed directories as readable text", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "notes.md");
    await writeFile(filePath, "# Notes\n\nText");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("# Notes\n\nText");
  });

  it("downloads active HTML and serves PDF inline from allowed directories", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const htmlPath = path.join(allowedDir, "README.print.html");
    const pdfPath = path.join(allowedDir, "README.pdf");
    const htmlSource =
      '<!doctype html><title>Readme</title><script>document.title = "EXECUTED"</script>';
    await writeFile(htmlPath, htmlSource);
    await writeFile(pdfPath, "%PDF-1.4\n");

    const routes = createLocalFileRoutes({ allowedPaths: [allowedDir] });

    const htmlResponse = await routes.request(
      `/?path=${encodeURIComponent(htmlPath)}`,
    );
    expect(htmlResponse.status).toBe(200);
    expect(htmlResponse.headers.get("content-type")?.toLowerCase()).toBe(
      "text/html; charset=utf-8",
    );
    expect(htmlResponse.headers.get("content-disposition")).toContain(
      "attachment",
    );
    expect(htmlResponse.headers.get("content-security-policy")).toContain(
      "sandbox",
    );
    expect(htmlResponse.headers.get("content-security-policy")).toContain(
      "script-src 'none'",
    );
    expect(htmlResponse.headers.get("referrer-policy")).toBe("no-referrer");
    expect(htmlResponse.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await htmlResponse.text()).toBe(htmlSource);

    const pdfResponse = await routes.request(
      `/?path=${encodeURIComponent(pdfPath)}`,
    );
    expect(pdfResponse.status).toBe(200);
    expect(pdfResponse.headers.get("content-type")).toBe("application/pdf");
    expect(pdfResponse.headers.get("content-disposition")).toContain("inline");
    expect(pdfResponse.headers.get("content-security-policy")).toBeNull();
    expect(await pdfResponse.text()).toBe("%PDF-1.4\n");
  });

  it("serves source files as plain text when the extension map is incomplete", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "safe-markdown.ts");
    await writeFile(filePath, "export const route = 'local-file';\n");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("export const route = 'local-file';\n");
  });

  it("renders Markdown files with relative images when requested", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    const docsDir = path.join(allowedDir, "docs");
    await mkdir(docsDir, { recursive: true });

    const imagePath = path.join(docsDir, "diagram.svg");
    const filePath = path.join(docsDir, "notes.md");
    await writeFile(imagePath, "<svg></svg>");
    await writeFile(
      filePath,
      "# Notes\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\n![diagram](diagram.svg)",
    );

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}&render=1`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.toLowerCase()).toBe(
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    expect(html).toContain("<h1>Notes</h1>");
    expect(html).toContain("<table>");
    const resolvedImagePath = await realpath(imagePath);
    expect(html).toContain(
      `src="/api/local-image?path=${encodeURIComponent(resolvedImagePath)}"`,
    );
    expect(html).toContain("Raw");
    expect(html).toContain("document-actions__dock");
    expect(html).toContain("Keep raw link at document top");
    expect(html).not.toContain("Print");
  });

  it("renders Quarto includes as local file-viewer links", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    const docsDir = path.join(allowedDir, "docs");
    await mkdir(docsDir, { recursive: true });

    const includePath = path.join(docsDir, "_introduction.qmd");
    const filePath = path.join(docsDir, "report.qmd");
    await writeFile(includePath, "Introduction");
    await writeFile(filePath, "# Report\n\n{{< include _introduction.qmd >}}");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });
    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}&render=1`,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    const resolvedIncludePath = await realpath(includePath);
    expect(html).toContain("<h1>Report</h1>");
    expect(html).toContain(
      `href="/api/local-file?path=${encodeURIComponent(resolvedIncludePath)}&amp;render=1"`,
    );
    expect(html).toContain('data-ya-render-markdown="true"');
  });

  it("marks and navigates to requested Markdown source lines", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "notes.md");
    await writeFile(
      filePath,
      "# Notes\n\nFirst paragraph.\n\nTarget paragraph.\n\nTail.",
    );

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}&render=1&line=5`,
    );

    expect(response.status).toBe(200);
    const html = await response.text();
    const resolvedFilePath = await realpath(filePath);
    expect(html).toContain(
      'class="markdown-preview-span markdown-preview-span-start" data-line-start="5" data-line-end="5"',
    );
    expect(html).toContain(
      `class="document-actions__raw" href="/api/local-file?path=${encodeURIComponent(resolvedFilePath)}&amp;render=0&amp;line=5"`,
    );
    expect(html).toContain('class="has-line-target-arrival"');
    expect(html).toContain('querySelector(".markdown-preview-span-start")');
    expect(html).toContain('scrollIntoView({ block: "start" })');
    expect(html).toContain('classList.remove("has-line-target-arrival")');
    expect(html).toContain('window.open(rawLink.href, "_blank")');
    expect(html).toContain(
      "rawWindow.scrollY + rect.top - rawWindow.innerHeight * 0.1",
    );

    const rawResponse = await routes.request(
      `/?path=${encodeURIComponent(filePath)}&render=0&line=5`,
    );
    expect(rawResponse.status).toBe(200);
    expect(rawResponse.headers.get("content-type")).toBe(
      "text/plain; charset=utf-8",
    );
    expect(await rawResponse.text()).toBe(
      "# Notes\n\nFirst paragraph.\n\nTarget paragraph.\n\nTail.",
    );

    const outOfRangeResponse = await routes.request(
      `/?path=${encodeURIComponent(filePath)}&render=1&line=99`,
    );
    const outOfRangeHtml = await outOfRangeResponse.text();
    expect(outOfRangeHtml).not.toContain(
      'class="markdown-preview-span markdown-preview-span-start"',
    );
    expect(outOfRangeHtml).not.toContain(
      '<body class="has-line-target-arrival">',
    );
    expect(outOfRangeHtml).not.toContain(
      'querySelector(".markdown-preview-span-start")',
    );
    expect(outOfRangeHtml).toContain(
      `class="document-actions__raw" href="/api/local-file?path=${encodeURIComponent(resolvedFilePath)}&amp;render=0"`,
    );
  });

  it.skipIf(process.platform !== "win32")(
    "serves Windows drive paths encoded like browser URL pathnames",
    async () => {
      const allowedDir = path.join(tempDir, "allowed");
      await mkdir(allowedDir, { recursive: true });

      const filePath = path.join(allowedDir, "notes.md");
      await writeFile(filePath, "# Notes\n\nText");
      const browserPathname = `/${filePath.replaceAll("\\", "/")}`;

      const routes = createLocalFileRoutes({
        allowedPaths: [allowedDir],
      });

      const response = await routes.request(
        `/?path=${encodeURIComponent(browserPathname)}&render=1`,
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")?.toLowerCase()).toBe(
        "text/html; charset=utf-8",
      );
      expect(await response.text()).toContain("<h1>Notes</h1>");
    },
  );

  it("treats an inline markdown line suffix as a location hint", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "notes.md");
    await writeFile(filePath, "# Notes\n\nText");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(`${filePath}:2`)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")?.toLowerCase()).toBe(
      "text/html; charset=utf-8",
    );
    const html = await response.text();
    expect(html).toContain("<h1>Notes</h1>");
    expect(html).toContain("Raw");
  });

  it("rejects non-text media extensions", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    await mkdir(allowedDir, { recursive: true });

    const filePath = path.join(allowedDir, "screenshot.png");
    await writeFile(filePath, "png-bytes");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({
      error: "Not a supported local file",
    });
  });

  it("rejects non-absolute paths before local file type checks", async () => {
    const routes = createLocalFileRoutes({
      allowedPaths: [tempDir],
    });

    const response = await routes.request("/?path=relative-image.png");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "Path must be absolute",
    });
  });

  it("rejects supported files outside the allowed directories", async () => {
    const allowedDir = path.join(tempDir, "allowed");
    const otherDir = path.join(tempDir, "allowed-sibling");
    await mkdir(allowedDir, { recursive: true });
    await mkdir(otherDir, { recursive: true });

    const filePath = path.join(otherDir, "outside.json");
    await writeFile(filePath, "{}");

    const routes = createLocalFileRoutes({
      allowedPaths: [allowedDir],
    });

    const response = await routes.request(
      `/?path=${encodeURIComponent(filePath)}`,
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: "Path not in allowed directories",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinks that resolve outside allowed directories",
    async () => {
      const allowedDir = path.join(tempDir, "allowed");
      const otherDir = path.join(tempDir, "other");
      await mkdir(allowedDir, { recursive: true });
      await mkdir(otherDir, { recursive: true });

      const outsideFile = path.join(otherDir, "outside.json");
      const linkPath = path.join(allowedDir, "linked.json");
      await writeFile(outsideFile, "{}");
      await symlink(outsideFile, linkPath);

      const routes = createLocalFileRoutes({
        allowedPaths: [allowedDir],
      });

      const response = await routes.request(
        `/?path=${encodeURIComponent(linkPath)}`,
      );

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Path not in allowed directories",
      });
    },
  );
});
