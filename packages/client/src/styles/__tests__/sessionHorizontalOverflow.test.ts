// @vitest-environment node

import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const sessionStylesheetUrl = new URL("../index.css", import.meta.url);
const galleryStylesheetUrl = new URL(
  "../../components/TurnImageGallery.module.css",
  import.meta.url,
);
const rendererStylesheetUrl = new URL("../renderers.css", import.meta.url);

describe("session horizontal overflow contract", () => {
  it("clips the outer transcript while keeping local content scrollers", async () => {
    const [sessionCss, galleryCss, rendererCss] = await Promise.all([
      readFile(sessionStylesheetUrl, "utf8"),
      readFile(galleryStylesheetUrl, "utf8"),
      readFile(rendererStylesheetUrl, "utf8"),
    ]);

    expect(sessionCss).toMatch(
      /\.session-messages\s*\{[^}]*overflow:\s*clip auto\s*;/s,
    );
    expect(galleryCss).toMatch(
      /\.rows\s*\{[^}]*overflow-x:\s*auto\s*;[^}]*overflow-y:\s*hidden\s*;/s,
    );
    expect(rendererCss).toMatch(
      /\.code-block\s*\{[^}]*overflow-x:\s*auto\s*;/s,
    );
  });
});
