// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  calculateSourceAutoFilesWidth,
  calculateSourceFilesMaxWidth,
} from "./ResizableSourceColumns";

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
      revisionWidth + gapWidth + filesWidth + gapWidth / 2 + handleWidth / 2,
    ).toBe(containerWidth);
  });

  it("right-sizes detail and may reduce an oversized file list", () => {
    expect(
      calculateSourceAutoFilesWidth({
        containerWidth: 1_200,
        gapWidth: 12,
        naturalDetailWidth: 500,
        currentFilesWidth: 800,
        defaultFilesWidth: 340,
        filesMax: 1_181,
      }),
    ).toBe(688);
  });

  it("limits detail expansion by the default-width neighboring pane", () => {
    expect(
      calculateSourceAutoFilesWidth({
        containerWidth: 1_200,
        gapWidth: 12,
        naturalDetailWidth: 1_000,
        currentFilesWidth: 700,
        defaultFilesWidth: 340,
        filesMax: 1_181,
      }),
    ).toBe(340);
  });

  it("preserves a neighboring pane manually narrowed below default", () => {
    expect(
      calculateSourceAutoFilesWidth({
        containerWidth: 800,
        gapWidth: 12,
        naturalDetailWidth: 700,
        currentFilesWidth: 260,
        defaultFilesWidth: 340,
        filesMax: 781,
      }),
    ).toBe(260);
  });
});
