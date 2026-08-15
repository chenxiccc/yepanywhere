import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("hosted remote asset headers", () => {
  it("keeps generated assets immutable and entry resources revalidated", async () => {
    const headers = await readFile(resolve("public/_headers"), "utf8");

    expect(headers).toMatch(
      /\/assets\/\*[\s\S]*Cache-Control: public, max-age=31536000, immutable/,
    );
    for (const mutablePath of [
      "/index.html",
      "/remote.html",
      "/sw.js",
      "/manifest.json",
      "/asset-generation.json",
    ]) {
      expect(headers).toContain(
        `${mutablePath}\n  Cache-Control: public, max-age=0, must-revalidate`,
      );
    }
  });
});
