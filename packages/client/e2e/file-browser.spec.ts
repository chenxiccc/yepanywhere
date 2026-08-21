import { join } from "node:path";
import { e2ePaths, expect, test } from "./fixtures.js";

let projectId: string;
let projectPath: string;

test.beforeAll(() => {
  projectPath = join(e2ePaths.tempDir, "file-browser-project");
  projectId = Buffer.from(projectPath).toString("base64url");
});

test.describe("Files API", () => {
  test("returns file content for text files", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files?path=test.txt`,
    );

    expect(response.ok()).toBe(true);
    const data = await response.json();
    expect(data.metadata.path).toBe("test.txt");
    expect(data.metadata.isText).toBe(true);
    expect(data.content).toBe("Hello from test file!");
    expect(data.rawUrl).toContain("/files/raw");
  });

  test("returns raw file with correct content-type", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files/raw?path=data.json`,
    );

    expect(response.ok()).toBe(true);
    expect(response.headers()["content-type"]).toBe("application/json");
    const text = await response.text();
    expect(text).toBe('{"key": "value"}');
  });

  test("sets attachment disposition for downloads", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files/raw?path=test.txt&download=true`,
    );

    expect(response.ok()).toBe(true);
    expect(response.headers()["content-disposition"]).toContain("attachment");
    expect(response.headers()["content-disposition"]).toContain("test.txt");
  });

  test("downloads active project documents instead of executing them", async ({
    baseURL,
    page,
    request,
  }) => {
    const activeDocuments = [
      {
        filename: "hostile.html",
        url: `/api/projects/${projectId}/files/raw?path=hostile.html`,
      },
      {
        filename: "hostile.svg",
        url: `/api/projects/${projectId}/files/raw?path=hostile.svg`,
      },
      {
        filename: "hostile.html",
        url: `/api/local-file?path=${encodeURIComponent(join(projectPath, "hostile.html"))}`,
      },
    ];

    for (const { filename, url } of activeDocuments) {
      const response = await request.get(url);
      expect(response.ok()).toBe(true);
      expect(response.headers()["content-disposition"]).toContain("attachment");
      expect(response.headers()["content-security-policy"]).toContain(
        "script-src 'none'",
      );

      await page.goto(baseURL);
      await page.setContent(
        `<a id="active-file" href="${baseURL}${url}">Open active file</a>`,
      );
      const downloadPromise = page.waitForEvent("download");
      await page.locator("#active-file").click();
      const download = await downloadPromise;
      expect(download.suggestedFilename()).toBe(filename);
      await expect(page).not.toHaveTitle("EXECUTED");
    }
  });

  test("rejects path traversal attempts", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files?path=../../../etc/passwd`,
    );

    expect(response.status()).toBe(400);
    const data = await response.json();
    expect(data.error).toBe("Invalid file path");
  });

  test("returns 404 for non-existent files", async ({ request }) => {
    const response = await request.get(
      `/api/projects/${projectId}/files?path=does-not-exist.txt`,
    );

    expect(response.status()).toBe(404);
    const data = await response.json();
    expect(data.error).toBe("File not found");
  });
});
