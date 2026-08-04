import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PublicShareProvider } from "../../contexts/PublicShareContext";
import { I18nProvider } from "../../i18n";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../lib/clientSummaryStore";
import { getNewSessionPrefill } from "../../lib/newSessionPrefill";
import { UI_KEYS } from "../../lib/storageKeys";
import type { FileViewerSource } from "../FileViewer";
import { FilePathLink, FileViewerModal } from "../FilePathLink";

describe("FilePathLink", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
    window.localStorage.removeItem(UI_KEYS.tooltipMode);
  });

  it("renders a native link to the standalone file viewer", () => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "native");
    render(
      <FilePathLink
        projectId="project-id"
        filePath="docs/guide.md"
        lineNumber={12}
        displayText="guide.md"
      />,
    );

    const link = screen.getByRole("link", { name: /guide\.md\s*:12/ });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-id/file?path=docs%2Fguide.md&line=12",
    );
    expect(link.getAttribute("title")).toBe("docs/guide.md:12");
    expect(link.getAttribute("data-tooltip")).toBeNull();
  });

  it("copies the standalone viewer URL from the context menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    render(
      <I18nProvider>
        <FilePathLink
          projectId="project-id"
          filePath="docs/guide.md"
          lineNumber={12}
          displayText="guide.md"
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(
      screen.getByRole("link", { name: /guide\.md\s*:12/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy URL" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "http://localhost:3000/projects/project-id/file?path=docs%2Fguide.md&line=12",
      );
    });
  });

  it("does not traverse history while opening in Strict Mode", async () => {
    const historyBack = vi
      .spyOn(window.history, "back")
      .mockImplementation(() => {});
    const source: FileViewerSource = {
      loadFile: vi.fn(() => new Promise<never>(() => {})),
    };

    const { unmount } = render(
      <StrictMode>
        <I18nProvider>
          <FileViewerModal
            projectId="project-id"
            filePath="docs/guide.md"
            source={source}
            onClose={() => {}}
          />
        </I18nProvider>
      </StrictMode>,
    );

    expect(screen.getByRole("dialog")).toBeDefined();
    expect(historyBack).not.toHaveBeenCalled();

    unmount();
    await waitFor(() => expect(historyBack).toHaveBeenCalledTimes(1));
  });

  it("uses only the concise native path hint in native tooltip mode", () => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "native");
    render(
      <FilePathLink
        projectId="project-id"
        filePath="docs/guide.md"
        lineNumber={12}
        lineEnd={16}
        displayText="5 lines"
        showLineSuffix={false}
      />,
    );

    const link = screen.getByRole("link", { name: "5 lines" });
    expect(link.getAttribute("title")).toBe("docs/guide.md:12-16");
    expect(link.getAttribute("data-tooltip")).toBeNull();
  });

  it("renders file range links with lineEnd", () => {
    render(
      <FilePathLink
        projectId="project-id"
        filePath="docs/guide.md"
        lineNumber={12}
        lineEnd={16}
        displayText="guide.md"
      />,
    );

    const link = screen.getByRole("link", { name: /guide\.md\s*:12-16/ });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-id/file?path=docs%2Fguide.md&line=12&lineEnd=16",
    );
  });

  it("renders compact range links with view=range", () => {
    render(
      <FilePathLink
        projectId="project-id"
        filePath="docs/guide.md"
        lineNumber={12}
        lineEnd={16}
        displayText="5 lines"
        showLineSuffix={false}
        viewMode="range"
      />,
    );

    const link = screen.getByRole("link", { name: "5 lines" });
    expect(link.getAttribute("href")).toBe(
      "/projects/project-id/file?path=docs%2Fguide.md&line=12&lineEnd=16&view=range",
    );
  });

  it("links absolute paths under the project as project-relative paths", () => {
    const projectId = toUrlProjectId("/local/graehl/yepanywhere");

    render(
      <FilePathLink
        projectId={projectId}
        filePath="/local/graehl/yepanywhere/ui-report/README.md"
        lineNumber={8}
        displayText="ui-report/README.md"
      />,
    );

    const link = screen.getByRole("link", {
      name: /ui-report\/README\.md\s*:8/,
    });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=ui-report%2FREADME.md&line=8`,
    );
  });

  it("links Windows absolute paths under the project as project-relative paths", () => {
    const projectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const projectId = toUrlProjectId(projectRoot);

    render(
      <FilePathLink
        projectId={projectId}
        filePath={`${projectRoot}\\docs\\tactical\\note.md`}
        lineNumber={8}
        displayText="docs/tactical/note.md"
      />,
    );

    const link = screen.getByRole("link", {
      name: /docs\/tactical\/note\.md\s*:8/,
    });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=docs%2Ftactical%2Fnote.md&line=8`,
    );
  });

  it("keeps Windows absolute paths outside the project absolute", () => {
    const projectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const projectId = toUrlProjectId(projectRoot);

    render(
      <FilePathLink
        projectId={projectId}
        filePath={"D:\\scratch\\outside.md"}
        lineNumber={4}
        displayText="outside.md"
      />,
    );

    const link = screen.getByRole("link", { name: /outside\.md\s*:4/ });
    expect(link.getAttribute("href")).toBe(
      `/projects/${projectId}/file?path=D%3A%5Cscratch%5Coutside.md&line=4`,
    );
  });

  it("renders a copy-path button that copies the path without bubbling", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const containerClick = vi.fn();

    render(
      // biome-ignore lint/a11y/noStaticElementInteractions: asserts non-bubbling
      // biome-ignore lint/a11y/useKeyWithClickEvents: test-only wrapper
      <div onClick={containerClick}>
        <FilePathLink
          projectId="project-id"
          filePath="docs/guide.md"
          lineNumber={12}
          displayText="guide.md"
        />
      </div>,
    );

    const copyButton = screen.getByRole("button", { name: "Copy path" });
    fireEvent.click(copyButton);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Copied path" }),
      ).toBeDefined();
    });

    expect(writeText).toHaveBeenCalledWith("docs/guide.md");
    expect(containerClick).not.toHaveBeenCalled();
  });

  it("copies absolute paths under the project as project-relative", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const projectId = toUrlProjectId("/local/graehl/yepanywhere");

    render(
      <FilePathLink
        projectId={projectId}
        filePath="/local/graehl/yepanywhere/ui-report/README.md"
        displayText="ui-report/README.md"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Copied path" }),
      ).toBeDefined();
    });

    expect(writeText).toHaveBeenCalledWith("ui-report/README.md");
  });

  it("copies paths outside the project verbatim", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const projectId = toUrlProjectId("/local/graehl/yepanywhere");

    render(
      <FilePathLink
        projectId={projectId}
        filePath="/home/graehl/.claude/CLAUDE.md"
        displayText="CLAUDE.md"
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy path" }));
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Copied path" }),
      ).toBeDefined();
    });

    expect(writeText).toHaveBeenCalledWith("/home/graehl/.claude/CLAUDE.md");
  });

  it("omits the copy button when showCopyButton is false", () => {
    render(
      <FilePathLink
        projectId="project-id"
        filePath="docs/guide.md"
        displayText="guide.md"
        showCopyButton={false}
      />,
    );

    expect(screen.queryByRole("button", { name: "Copy path" })).toBeNull();
  });

  it("opens a context menu that can prefill a new session from the path", () => {
    render(
      <I18nProvider>
        <FilePathLink
          projectId="project-id"
          filePath="docs/guide.md"
          displayText="guide.md"
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("link", { name: "guide.md" }), {
      clientX: 20,
      clientY: 30,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "New session" }));

    expect(getNewSessionPrefill(LOCAL_CLIENT_SUMMARY_SOURCE_KEY)).toBe(
      "docs/guide.md",
    );
    expect(window.location.pathname).toBe("/new-session");
    expect(window.location.search).toBe("?projectId=project-id");
  });

  it("copies file contents from the context menu", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        return new Response(
          JSON.stringify({
            metadata: {
              path: "docs/guide.md",
              size: 9,
              mimeType: "text/markdown",
              isText: true,
            },
            rawUrl: "",
            content: "# Guide\n",
          }),
          {
            headers: { "Content-Type": "application/json" },
            status: 200,
          },
        );
      }),
    );

    render(
      <I18nProvider>
        <FilePathLink
          projectId="project-id"
          filePath="docs/guide.md"
          displayText="guide.md"
        />
      </I18nProvider>,
    );

    fireEvent.contextMenu(screen.getByRole("link", { name: "guide.md" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Copy contents" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("# Guide\n");
    });
  });

  it("uses share-scoped file routes when rendered in a public share", () => {
    const projectId = toUrlProjectId("/local/graehl/yepanywhere");

    render(
      <PublicShareProvider
        value={{
          projectId,
          relayUrl: "wss://relay.graehl.org/ws",
          relayUsername: "ygraehl",
          secret: "share-secret",
        }}
      >
        <FilePathLink
          projectId={projectId}
          filePath="/local/graehl/yepanywhere/ui-report/README.md"
          lineNumber={8}
          lineEnd={12}
          displayText="ui-report/README.md"
          viewMode="range"
        />
      </PublicShareProvider>,
    );

    const link = screen.getByRole("link", {
      name: /ui-report\/README\.md\s*:8/,
    });
    expect(link.getAttribute("href")).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}&line=8&lineEnd=12&view=range`,
    );
  });
});
