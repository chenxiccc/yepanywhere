import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../i18n";
import {
  getImagePathCoordinates,
  getProjectImageViewerLink,
  useImageResourceActions,
} from "../ImageResourceActions";

function TestImage({
  filePath,
  loadBlob,
}: {
  filePath?: string;
  loadBlob?: () => Promise<Blob>;
}) {
  const { contextMenuElement, handleContextMenu } = useImageResourceActions({
    fileName: "capture.png",
    filePath,
    loadBlob,
    onOpen: vi.fn(),
  });
  return (
    <>
      <button type="button" onContextMenu={handleContextMenu}>
        capture.png
      </button>
      {contextMenuElement}
    </>
  );
}

function renderImage(
  props: Parameters<typeof TestImage>[0],
  projectPath = "/repo",
) {
  return render(
    <I18nProvider>
      <SessionMetadataProvider
        projectId="project-id"
        projectPath={projectPath}
        sessionId="session-id"
      >
        <TestImage {...props} />
      </SessionMetadataProvider>
    </I18nProvider>,
  );
}

describe("image resource actions", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("classifies project and host path coordinates independently", () => {
    expect(
      getImagePathCoordinates({
        exposeAbsolutePath: true,
        filePath: "/repo/artifacts/capture.png",
        projectPath: "/repo",
      }),
    ).toEqual({
      absolutePath: "/repo/artifacts/capture.png",
      filePath: null,
      projectRelativePath: "artifacts/capture.png",
    });
    expect(
      getImagePathCoordinates({
        exposeAbsolutePath: false,
        filePath: "/repo/artifacts/capture.png",
        projectPath: "/repo",
      }),
    ).toEqual({
      absolutePath: null,
      filePath: null,
      projectRelativePath: "artifacts/capture.png",
    });
    expect(
      getImagePathCoordinates({
        exposeAbsolutePath: false,
        filePath: "/host/private/capture.png",
        projectPath: "/repo",
      }),
    ).toEqual({
      absolutePath: null,
      filePath: null,
      projectRelativePath: null,
    });
    expect(
      getImagePathCoordinates({
        exposeAbsolutePath: true,
        filePath: null,
        projectPath: "/repo",
      }),
    ).toEqual({
      absolutePath: null,
      filePath: null,
      projectRelativePath: null,
    });
  });

  it("builds viewer links only from project-owned coordinates", () => {
    expect(
      getProjectImageViewerLink({
        basePath: "/-/relay/test-host",
        projectId: "project-id",
        projectRelativePath: "artifacts/capture.png",
      }),
    ).toBe(
      "/-/relay/test-host/projects/project-id/file?path=artifacts%2Fcapture.png",
    );
    expect(
      getProjectImageViewerLink({
        projectId: "project-id",
        projectRelativePath: null,
      }),
    ).toBeNull();
  });

  it("omits path actions for pathless image data", () => {
    renderImage({ loadBlob: async () => new Blob(["png"]) });
    fireEvent.contextMenu(screen.getByRole("button", { name: "capture.png" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["‹Back", "Image"]);
  });

  it("offers both project-relative and absolute coordinates when known", () => {
    renderImage({
      filePath: "/repo/artifacts/capture.png",
      loadBlob: async () => new Blob(["png"]),
    });
    fireEvent.contextMenu(screen.getByRole("button", { name: "capture.png" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy" }));

    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "‹Back",
      "Image",
      "Project-relative path",
      "Absolute file path",
      "Viewer link",
    ]);
  });
});
