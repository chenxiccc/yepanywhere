// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  ResizableSourceColumns,
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

  it("fully hides and restores the commit selector's previous width", () => {
    const rendered = render(
      <ResizableSourceColumns
        layout="history"
        className="commit-browser-columns"
        t={(key) => key}
      >
        <div className="commit-list-column">commits</div>
        <div>files</div>
        <div>detail</div>
      </ResizableSourceColumns>,
    );
    const root = rendered.container.querySelector<HTMLElement>(
      ".commit-browser-columns",
    )!;
    const handle = screen.getAllByRole("separator", {
      name: "sourceResizeRevisionPane",
    })[0]!;

    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "316px",
    );

    fireEvent.click(handle);
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "0px",
    );
    expect(handle.getAttribute("title")).toBe("sourceShowRevisionPane");

    fireEvent.click(handle);
    expect(root.style.getPropertyValue("--source-revision-column-width")).toBe(
      "316px",
    );
    expect(handle.getAttribute("title")).toBe("sourceHideRevisionPane");
  });
});
