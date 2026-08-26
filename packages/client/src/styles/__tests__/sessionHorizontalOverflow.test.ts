// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sessionStylesheetUrl = new URL("../index.css", import.meta.url);
const galleryStylesheetUrl = new URL(
  "../../components/TurnImageGallery.module.css",
  import.meta.url,
);
const rendererStylesheetUrl = new URL("../renderers.css", import.meta.url);
const sessionPageStylesheetUrl = new URL(
  "../../pages/SessionPage.module.css",
  import.meta.url,
);

describe("session horizontal overflow contract", () => {
  it("keeps a contained transcript fallback alongside local scrollers", async () => {
    const [sessionCss, galleryCss, rendererCss, sessionPageCss] =
      await Promise.all([
        readFile(sessionStylesheetUrl, "utf8"),
        readFile(galleryStylesheetUrl, "utf8"),
        readFile(rendererStylesheetUrl, "utf8"),
        readFile(sessionPageStylesheetUrl, "utf8"),
      ]);

    expect(sessionCss).toMatch(
      /\.session-messages\s*\{[^}]*overflow:\s*auto\s*;/s,
    );
    expect(sessionCss).toMatch(
      /\.session-split\.session-split-with-aside\s*>\s*\.session-messages\s*\{[^}]*overflow-x:\s*auto\s*;/s,
    );
    expect(sessionPageCss).toMatch(
      /\.sessionSplit:global\(\.session-split\)\s*\{[^}]*min-width:\s*0\s*;[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;/s,
    );
    expect(sessionPageCss).toMatch(/\.messages\s*\{[^}]*min-width:\s*0\s*;/s);
    expect(galleryCss).toMatch(
      /\.rows\s*\{[^}]*overflow-x:\s*auto\s*;[^}]*overflow-y:\s*hidden\s*;/s,
    );
    expect(rendererCss).toMatch(
      /\.code-block\s*\{[^}]*overflow-x:\s*auto\s*;/s,
    );
  });
});
