import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId, type FileContentResponse } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../lib/clientSummaryStore";
import { extractMarkdownSnippetsFromSelection } from "../../lib/markdownSelectionCopy";
import { getNewSessionPrefill } from "../../lib/newSessionPrefill";
import { FileViewer, type FileViewerSource } from "../FileViewer";

const mocks = vi.hoisted(() => ({
  useFileVersionControl: vi.fn(),
}));

vi.mock("../../hooks/useFileVersionControl", () => ({
  useFileVersionControl: mocks.useFileVersionControl,
}));
vi.mock("../../pages/GitStatusDiffPreview", () => ({
  GitDiffBody: ({ source }: { source: unknown }) => (
    <div data-testid="file-diff-body">{JSON.stringify(source)}</div>
  ),
}));

const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
const originalGetBoundingClientRect =
  HTMLElement.prototype.getBoundingClientRect;
const originalClientHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "clientHeight",
);
const originalScrollHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollHeight",
);
const originalScrollTopDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "scrollTop",
);
const originalCreateObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);
const originalWindowOpenDescriptor = Object.getOwnPropertyDescriptor(
  window,
  "open",
);

function restorePrototypeProperty(
  name: keyof HTMLElement,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(HTMLElement.prototype, name, descriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, name);
  }
}

function restoreObjectProperty(
  target: object,
  name: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    Reflect.deleteProperty(target, name);
  }
}

describe("FileViewer", () => {
  beforeEach(() => {
    mocks.useFileVersionControl.mockReset();
    mocks.useFileVersionControl.mockReturnValue({
      cumulativeFile: null,
      loading: false,
      relativePath: null,
      supported: false,
      worktreeFile: null,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
  });

  it("makes cumulative diff override source line ranges", async () => {
    const cumulativeFile = {
      path: "src/App.ts",
      status: "M",
      staged: false,
      linesAdded: 3,
      linesDeleted: 1,
    };
    mocks.useFileVersionControl.mockReturnValue({
      cumulativeFile,
      loading: false,
      relativePath: "src/App.ts",
      supported: true,
      worktreeFile: null,
    });
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "src/App.ts",
          size: 12,
          mimeType: "text/typescript",
          isText: true,
        },
        rawUrl: "",
        content: "source\n",
      })),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          lineNumber={12}
          lineEnd={16}
          viewMode="range"
          diffMode="cumulative"
          source={source}
        />
      </I18nProvider>,
    );

    expect((await screen.findByTestId("file-diff-body")).textContent).toContain(
      '"mode":"cumulative"',
    );
    expect(source.loadFile).not.toHaveBeenCalled();
    const cumulative = screen.getByRole("link", {
      name: "View cumulative HEAD^1 to working tree diff for src/App.ts",
    });
    expect(cumulative.getAttribute("href")).toBe(
      "/projects/project-id/file?path=src%2FApp.ts&diff=cumulative",
    );
    expect(cumulative.getAttribute("aria-current")).toBe("page");

    fireEvent.click(screen.getByRole("link", { name: "Source" }));
    await waitFor(() =>
      expect(source.loadFile).toHaveBeenCalledWith(
        "project-id",
        "src/App.ts",
        true,
        12,
        16,
        "range",
      ),
    );
  });

  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
    vi.unstubAllGlobals();
    if (originalScrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        configurable: true,
        value: originalScrollIntoView,
      });
    } else {
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
    }
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: originalGetBoundingClientRect,
    });
    restorePrototypeProperty("clientHeight", originalClientHeightDescriptor);
    restorePrototypeProperty("scrollHeight", originalScrollHeightDescriptor);
    restorePrototypeProperty("scrollTop", originalScrollTopDescriptor);
    restoreObjectProperty(
      URL,
      "createObjectURL",
      originalCreateObjectUrlDescriptor,
    );
    restoreObjectProperty(
      URL,
      "revokeObjectURL",
      originalRevokeObjectUrlDescriptor,
    );
    restoreObjectProperty(window, "open", originalWindowOpenDescriptor);
  });

  it("shows project-relative headers for Windows absolute project paths", async () => {
    const projectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const rawPath = `${projectRoot}\\docs\\guide.md`;
    const projectId = toUrlProjectId(projectRoot);
    const fileResponse: FileContentResponse = {
      metadata: {
        path: rawPath,
        size: 12,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "# Guide\n",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer projectId={projectId} filePath={rawPath} source={source} />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".file-viewer-path")?.textContent).toBe(
        "docs/guide.md",
      );
    });

    expect(
      container.querySelector(".file-viewer-path")?.getAttribute("title"),
    ).toBe(rawPath);
    expect(source.loadFile).toHaveBeenCalledWith(
      projectId,
      rawPath,
      true,
      undefined,
      undefined,
      "full",
    );
  });

  it("prefills a new session from the file viewer path", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "src/App.ts",
        size: 20,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "export {};\n",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          source={source}
        />
      </I18nProvider>,
    );

    const button = await screen.findByTitle("New session from path");
    fireEvent.click(button);

    expect(getNewSessionPrefill(LOCAL_CLIENT_SUMMARY_SOURCE_KEY)).toBe(
      "src/App.ts",
    );
    expect(window.location.pathname).toBe("/new-session");
    expect(window.location.search).toBe("?projectId=project-id");
  });

  it("marks and scrolls a line range 10% below the viewer top", async () => {
    let scrollTop = 0;
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? 100 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? 1000 : 0;
      },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get() {
        return this.classList.contains("file-viewer-body") ? scrollTop : 0;
      },
      set(value) {
        if (this.classList.contains("file-viewer-body")) {
          scrollTop = Number(value);
        }
      },
    });
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        const top = this.classList.contains("highlighted-line-start") ? 200 : 0;
        return {
          bottom: top,
          height: 0,
          left: 0,
          right: 0,
          toJSON: () => ({}),
          top,
          width: 0,
          x: 0,
          y: top,
        };
      },
    });
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "src/App.ts",
        size: 64,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "one\ntwo\nthree\nfour\n",
      highlightedHtml:
        '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span>\n<span class="line">three</span>\n<span class="line">four</span></code></pre>',
      highlightedLanguage: "typescript",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          lineNumber={2}
          lineEnd={3}
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".highlighted-line-start")).not.toBeNull();
    });

    expect(
      container
        .querySelector(".highlighted-line-start")
        ?.getAttribute("data-line"),
    ).toBe("2");
    expect(
      container
        .querySelector(".highlighted-line-end")
        ?.getAttribute("data-line"),
    ).toBe("3");
    const code = container.querySelector(".shiki-container code");
    expect(
      Array.from(code?.childNodes ?? []).some(
        (node) => node.nodeType === Node.TEXT_NODE && node.textContent === "\n",
      ),
    ).toBe(false);
    expect(container.querySelector(".highlighted-line")).toBeNull();
    expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(
        container.querySelector<HTMLElement>(".file-viewer-body")?.scrollTop,
      ).toBe(190);
    });
  });

  it("paints a single highlighted line", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "src/App.ts",
        size: 64,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "one\ntwo\nthree\n",
      contentStartLine: 40,
      highlightedHtml:
        '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span>\n<span class="line">three</span></code></pre>',
      highlightedLanguage: "typescript",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="src/App.ts"
          lineNumber={41}
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".highlighted-line")).not.toBeNull();
    });

    expect(
      container.querySelector(".highlighted-line")?.getAttribute("data-line"),
    ).toBe("41");
    expect(container.querySelector(".highlighted-line-start")).not.toBeNull();
    expect(container.querySelector(".highlighted-line-end")).not.toBeNull();
  });

  it("shows actual file line numbers in plain range windows", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "logs/session.txt",
        size: 64,
        mimeType: "text/plain",
        isText: true,
      },
      rawUrl: "",
      content: "alpha\nbeta\ngamma",
      contentStartLine: 40,
      contentEndLine: 42,
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="logs/session.txt"
          lineNumber={41}
          lineEnd={42}
          viewMode="range"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(container.querySelector(".code-highlighter-plain")).not.toBeNull();
    });

    const gutter = Array.from(
      container.querySelectorAll(".code-line-numbers > div"),
    ).map((node) => node.textContent);
    expect(gutter).toEqual(["40", "41", "42"]);
    expect(
      container
        .querySelector(".highlighted-line-start")
        ?.getAttribute("data-line"),
    ).toBe("41");
    expect(
      container
        .querySelector(".highlighted-line-end")
        ?.getAttribute("data-line"),
    ).toBe("42");

    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    expect(viewerBody?.getAttribute("data-markdown-copy-source")).toBe("true");
    const betaText = viewerBody?.querySelector('[data-line="41"]')?.firstChild;
    expect(betaText).toBeTruthy();
    const range = document.createRange();
    range.setStart(betaText as Node, 0);
    range.setEnd(betaText as Node, "beta".length);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: "beta",
        selectedText: "beta",
      },
    ]);
  });

  it("opens Markdown range views rendered and keeps source toggleable", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "notes.md",
        size: 64,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: "# Title\n\nSelected text",
      contentStartLine: 10,
      contentEndLine: 12,
      highlightedHtml:
        '<pre class="shiki"><code><span class="line"># Title</span>\n<span class="line"></span>\n<span class="line">Selected text</span></code></pre>',
      renderedMarkdownHtml:
        '<div class="markdown-preview-line-boundary markdown-preview-line-boundary-start" data-line="10"></div><div class="markdown-preview-span markdown-preview-span-start" data-line-start="10" data-line-end="12"><h1>Title</h1><p>Selected text</p></div><div class="markdown-preview-line-boundary markdown-preview-line-boundary-end" data-line="12"></div>',
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.md"
          lineNumber={10}
          lineEnd={12}
          viewMode="range"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Preview" })).toBeTruthy();
    });

    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    expect(
      container.querySelector(".markdown-preview-span-start"),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(container.querySelector(".shiki-container")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    const heading = await screen.findByRole("heading", { name: "Title" });
    const headingText = heading.firstChild;
    expect(headingText).toBeTruthy();
    const range = document.createRange();
    range.selectNodeContents(headingText as Node);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: "# Title",
        selectedText: "Title",
      },
    ]);
  });

  it("opens Quarto files rendered and maps include selections to source", async () => {
    const sourceMarkdown = "{{< include _introduction.qmd >}}";
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "report.qmd",
        size: sourceMarkdown.length,
        mimeType: "text/markdown",
        isText: true,
      },
      rawUrl: "",
      content: sourceMarkdown,
      highlightedHtml:
        '<pre class="shiki"><code><span class="line">{{&lt; include _introduction.qmd &gt;}}</span></code></pre>',
      renderedMarkdownHtml:
        '<p>Include: <a href="/projects/project-id/file?path=_introduction.qmd" data-ya-resource="project-file" data-ya-project-id="project-id" data-ya-path="_introduction.qmd"><code>_introduction.qmd</code></a></p>',
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="report.qmd"
          source={source}
        />
      </I18nProvider>,
    );

    const includePath = await screen.findByText("_introduction.qmd");
    const range = document.createRange();
    range.selectNodeContents(includePath);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: "_introduction.qmd",
        selectedText: "_introduction.qmd",
      },
    ]);

    range.selectNodeContents(includePath.closest("p")!);
    selection?.removeAllRanges();
    selection?.addRange(range);
    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: sourceMarkdown,
        selectedText: "Include: _introduction.qmd",
      },
    ]);
  });

  it("keeps HTML source-first and confines an explicit static preview", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "reports/demo.html",
        size: 96,
        mimeType: "text/html",
        isText: true,
      },
      rawUrl: "",
      content:
        '<h1>Preview heading</h1><script>parent.document.body.dataset.pwned="1"</script>',
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="reports/demo.html"
          source={source}
        />
      </I18nProvider>,
    );

    expect(await screen.findByRole("button", { name: "Preview" })).toBeTruthy();
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/Preview heading/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    const frame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).toBeTruthy();
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.srcdoc).toContain("Content-Security-Policy");
    expect(frame?.srcdoc).toContain("default-src 'none'");
    expect(document.body.dataset.pwned).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Source" }));
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("honors an HTML preview selected before the project viewer opens", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "reports/demo.html",
        size: 32,
        mimeType: "text/html",
        isText: true,
      },
      rawUrl: "",
      content: "<p>Chosen preview</p>",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="reports/demo.html"
          initialPresentation="preview"
          source={source}
        />
      </I18nProvider>,
    );

    await waitFor(() => expect(container.querySelector("iframe")).toBeTruthy());
    expect(screen.getByRole("button", { name: "Preview" }).classList).toContain(
      "active",
    );
  });

  it("opens image previews as raw image tabs", async () => {
    const fileResponse: FileContentResponse = {
      metadata: {
        path: "screenshots/result.png",
        size: 128,
        mimeType: "image/png",
        isText: false,
      },
      rawUrl:
        "/api/projects/project-id/files/raw?path=screenshots%2Fresult.png",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
      fetchRawFileBlob: vi.fn(
        async () => new Blob(["png"], { type: "image/png" }),
      ),
    };
    const openMock = vi.fn();
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:file-viewer-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(window, "open", {
      configurable: true,
      value: openMock,
    });

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="screenshots/result.png"
          source={source}
        />
      </I18nProvider>,
    );

    const imageLink = await screen.findByRole("link", {
      name: "Open image in new tab",
    });
    expect(imageLink.getAttribute("href")).toBe(
      "/api/projects/project-id/files/raw?path=screenshots%2Fresult.png",
    );
    expect(imageLink.getAttribute("target")).toBe("_blank");
    expect(imageLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(
      screen.getByRole("img", { name: "result.png" }).getAttribute("src"),
    ).toBe("blob:file-viewer-image");
    fireEvent.contextMenu(screen.getByRole("img", { name: "result.png" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Open",
      "Download",
      "Copy image",
      "Copy project-relative path",
      "Copy absolute file path",
      "Copy viewer link",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss image menu" }));

    const openButton = container.querySelector<HTMLButtonElement>(
      '.file-viewer-actions .file-viewer-action[title="Open image in new tab"]',
    );
    expect(openButton).not.toBeNull();
    fireEvent.click(openButton as HTMLButtonElement);

    expect(openMock).toHaveBeenCalledWith(
      "/api/projects/project-id/files/raw?path=screenshots%2Fresult.png",
      "_blank",
      "noopener",
    );
  });
});
