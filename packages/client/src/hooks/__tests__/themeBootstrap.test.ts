import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const clientRoot = path.resolve(import.meta.dirname, "../../..");

describe.each(["index.html", "remote.html"])("%s theme bootstrap", (file) => {
  const html = fs.readFileSync(path.join(clientRoot, file), "utf8");

  it("uses the same auto default as the React theme store", () => {
    expect(html).toContain("var theme = stored || 'auto';");
  });

  it("covers the viewport for dark and light auto themes", () => {
    expect(html).toContain('html[data-theme="auto"]');
    expect(html).toContain("html, body, #root { min-height: 100%");
    expect(html).toContain("body { margin: 0; background-color: inherit; }");
  });
});
