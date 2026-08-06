// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const stylesheetUrl = new URL(
  "../../components/TurnImageGallery.module.css",
  import.meta.url,
);

describe("phone turn-gallery natural-size contract", () => {
  it("caps mobile items by the measured natural dimensions", async () => {
    const css = await readFile(stylesheetUrl, "utf8");

    expect(css).toMatch(
      /\.item\s*\{[^}]*width:\s*var\(--turn-gallery-item-width\);[^}]*height:\s*var\(--turn-gallery-item-height\);/s,
    );
    expect(css).toMatch(
      /@media \(max-width: 700px\)[\s\S]*?\.item\s*\{[^}]*width:\s*min\([^}]*var\(--turn-gallery-natural-width, 320px\)[^}]*height:\s*min\([^}]*var\(--turn-gallery-natural-height, var\(--turn-gallery-max-height\)\)/s,
    );
    expect(css).not.toContain("width: min(78vw, 320px) !important;");
  });
});
