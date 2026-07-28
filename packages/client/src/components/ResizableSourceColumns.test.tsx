// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { calculateSourceFilesMaxWidth } from "./ResizableSourceColumns";

describe("Source Control file-pane resize bound", () => {
  it("keeps the file splitter handle inside a two-column container", () => {
    const containerWidth = 1_000;
    const gapWidth = 12;
    const handleWidth = 26;
    const filesWidth = calculateSourceFilesMaxWidth({
      layout: "files",
      containerWidth,
      revisionWidth: 0,
      gapWidth,
      handleWidth,
    });

    expect(filesWidth).toBe(981);
    expect(filesWidth + gapWidth / 2 + handleWidth / 2).toBe(containerWidth);
  });

  it("accounts for the revision track before the file splitter", () => {
    const containerWidth = 1_000;
    const revisionWidth = 300;
    const gapWidth = 12;
    const handleWidth = 26;
    const filesWidth = calculateSourceFilesMaxWidth({
      layout: "history",
      containerWidth,
      revisionWidth,
      gapWidth,
      handleWidth,
    });

    expect(filesWidth).toBe(669);
    expect(
      revisionWidth +
        gapWidth +
        filesWidth +
        gapWidth / 2 +
        handleWidth / 2,
    ).toBe(containerWidth);
  });
});
