import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId, type FileContentResponse } from "@yep-anywhere/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import { QuoteReplyProvider } from "../../contexts/QuoteReplyContext";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { SessionViewerCommentProvider } from "../../contexts/SessionViewerCommentContext";
import { setQuoteReplyButtonModePreference } from "../../hooks/useQuoteReplyButtonMode";
import { I18nProvider } from "../../i18n";
import { LOCAL_CLIENT_SUMMARY_SOURCE_KEY } from "../../lib/clientSummaryStore";
import { invalidateLocalStorageValues } from "../../lib/localStorageValue";
import { extractMarkdownSnippetsFromSelection } from "../../lib/markdownSelectionCopy";
import { getNewSessionPrefill } from "../../lib/newSessionPrefill";
import { UI_KEYS } from "../../lib/storageKeys";
import { FileViewer, type FileViewerSource } from "../FileViewer";
import { FileViewerModal } from "../FilePathLink";

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
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = vi.fn();
        disconnect = vi.fn();
      },
    );
    setQuoteReplyButtonModePreference("paragraph-hover");
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

  it("returns from a diff to the retained raw source without loading", async () => {
    mocks.useFileVersionControl.mockReturnValue({
      cumulativeFile: null,
      loading: false,
      relativePath: "notes.md",
      supported: true,
      worktreeFile: {
        path: "notes.md",
        status: "M",
        staged: false,
        linesAdded: 1,
        linesDeleted: 0,
      },
    });
    const source: FileViewerSource = {
      loadFile: vi
        .fn()
        .mockResolvedValueOnce({
          metadata: {
            path: "notes.md",
            size: 8,
            mimeType: "text/markdown",
            isText: true,
          },
          rawUrl: "",
          content: "# Notes\n",
          highlightedHtml:
            '<pre class="shiki"><code><span class="line"># Notes</span></code></pre>',
          renderedMarkdownHtml: "<h1>Notes</h1>",
        })
        .mockReturnValueOnce(new Promise(() => {})),
    };

    const { container } = render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.md"
          source={source}
        />
      </I18nProvider>,
    );

    expect(await screen.findByRole("heading", { name: "Notes" })).toBeTruthy();
    fireEvent.click(screen.getByText("vs HEAD"));
    expect(await screen.findByTestId("file-diff-body")).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Source" }));

    expect(container.querySelector(".shiki-container")).toBeTruthy();
    expect(screen.queryByText("Loading notes.md...")).toBeNull();
    expect(source.loadFile).toHaveBeenCalledTimes(1);
  });

  it("offers a Back control that closes a modal viewer", async () => {
    const onClose = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.txt",
          size: 5,
          mimeType: "text/plain",
          isText: true,
        },
        rawUrl: "",
        content: "notes",
      })),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId="project-id"
          filePath="notes.txt"
          source={source}
          onClose={onClose}
        />
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("backs out of an in-file viewer before closing its parent", async () => {
    const childResponse: FileContentResponse = {
      metadata: {
        path: "child.yml",
        size: 5,
        mimeType: "text/yaml",
        isText: true,
      },
      rawUrl: "",
      content: "child",
    };
    const getFile = vi.spyOn(api, "getFile").mockResolvedValue(childResponse);
    const onClose = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "parent.yml",
          size: 9,
          mimeType: "text/yaml",
          isText: true,
        },
        rawUrl: "",
        content: "child.yml",
        highlightedHtml:
          '<a href="/projects/project-id/file?path=child.yml" ' +
          'data-ya-resource="project-file" data-ya-project-id="project-id" ' +
          'data-ya-path="child.yml">child.yml</a>',
      })),
    };

    try {
      render(
        <I18nProvider>
          <FileViewerModal
            projectId="project-id"
            filePath="parent.yml"
            source={source}
            onClose={onClose}
          />
        </I18nProvider>,
      );

      fireEvent.click(await screen.findByRole("link", { name: "child.yml" }));
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(2),
      );
      expect(document.body.style.overflow).toBe("hidden");
      const backButtons = screen.getAllByRole("button", { name: "Back" });
      const childBack = backButtons.at(-1);
      if (!childBack) throw new Error("Nested file viewer has no Back control");
      fireEvent.click(childBack);
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(1),
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(document.body.style.overflow).toBe("hidden");

      fireEvent.click(screen.getByRole("link", { name: "child.yml" }));
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(2),
      );
      fireEvent.keyDown(document, { key: "Escape" });
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(1),
      );
      expect(onClose).not.toHaveBeenCalled();
      expect(document.body.style.overflow).toBe("hidden");

      fireEvent.click(screen.getByRole("link", { name: "child.yml" }));
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(2),
      );
      fireEvent.keyDown(document, { key: "Backspace" });
      await waitFor(() =>
        expect(screen.getAllByRole("dialog")).toHaveLength(1),
      );
      expect(onClose).not.toHaveBeenCalled();

      fireEvent.keyDown(document, { key: "Backspace" });
      expect(onClose).toHaveBeenCalledTimes(1);
      expect(getFile).toHaveBeenCalledWith(
        "project-id",
        "child.yml",
        true,
        undefined,
        undefined,
        "full",
      );
    } finally {
      getFile.mockRestore();
    }
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

  it("prefills a new session from a selected standalone file line", async () => {
    const projectRoot = "/work/project";
    const projectId = toUrlProjectId(projectRoot);
    const filePath = `${projectRoot}/src/App.ts`;
    const fileResponse: FileContentResponse = {
      metadata: {
        path: filePath,
        size: 30,
        mimeType: "text/typescript",
        isText: true,
      },
      rawUrl: "",
      content: "first line\nselected line\nthird line",
    };
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => fileResponse),
    };

    render(
      <I18nProvider>
        <FileViewer
          projectId={projectId}
          filePath={filePath}
          source={source}
          standalone
        />
      </I18nProvider>,
    );

    const selectedLine = await screen.findByText("selected line");
    const range = document.createRange();
    range.selectNodeContents(selectedLine);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

    fireEvent.contextMenu(screen.getByText("src/App.ts"));
    expect(screen.getByRole("menuitem", { name: "New session" })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: "Copy text" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss file menu" }));

    fireEvent.contextMenu(selectedLine, { clientX: 0, clientY: 0 });
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Copy text", "Copy source", "New session"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "New session" }));

    expect(getNewSessionPrefill(LOCAL_CLIENT_SUMMARY_SOURCE_KEY)).toBe(
      "src/App.ts:2\n\n> selected line",
    );
    expect(window.location.pathname).toBe("/new-session");
    expect(window.location.search).toBe(`?projectId=${projectId}`);
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
    const sourceLines = container.querySelectorAll<HTMLElement>(
      ".shiki-container .line",
    );
    expect(sourceLines[1]?.dataset.yaSourceStart).toBe("4");
    expect(sourceLines[1]?.dataset.yaSourceEnd).toBe("7");
    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    await waitFor(() =>
      expect(viewerBody?.getAttribute("data-markdown-copy-source")).toBe(
        "true",
      ),
    );
    const selectedRange = document.createRange();
    selectedRange.setStart(sourceLines[1]?.firstChild as Node, 0);
    selectedRange.setEnd(sourceLines[2]?.firstChild as Node, "three".length);
    const sourceSelection = document.getSelection();
    sourceSelection?.removeAllRanges();
    sourceSelection?.addRange(selectedRange);
    expect(extractMarkdownSnippetsFromSelection(viewerBody!)).toMatchObject([
      {
        markdown: "two\nthree",
        selectedText: "two\nthree",
        sourceStart: 4,
        sourceEnd: 13,
      },
    ]);
    sourceSelection?.removeAllRanges();
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
      expect(screen.getByRole("button", { name: "Raw source" })).toBeTruthy();
    });

    expect(await screen.findByRole("heading", { name: "Title" })).toBeTruthy();
    expect(
      container.querySelector(".markdown-preview-span-start"),
    ).toBeTruthy();
    const selectAll = screen.getByRole("button", { name: "Select all" });
    expect(selectAll.closest(".file-viewer-actions")).not.toBeNull();
    fireEvent.click(selectAll);
    expect(document.getSelection()?.toString()).toContain("Title");
    expect(document.getSelection()?.toString()).toContain("Selected text");
    document.getSelection()?.removeAllRanges();

    const rawSource = screen.getByRole("button", { name: "Raw source" });
    expect(rawSource.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(rawSource);
    expect(container.querySelector(".shiki-container")).toBeTruthy();
    expect(rawSource.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(rawSource);
    expect(rawSource.getAttribute("aria-pressed")).toBe("false");

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

  it("keeps select-all active while standalone selection actions mount", async () => {
    const originalRangeRect = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect",
    );
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        top: 100,
        right: 300,
        bottom: 120,
        left: 100,
        width: 200,
        height: 20,
        x: 100,
        y: 100,
        toJSON: () => ({}),
      }),
    });
    localStorage.setItem(UI_KEYS.selectionTextCopyActionEnabled, "true");
    invalidateLocalStorageValues(UI_KEYS.selectionTextCopyActionEnabled);
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 21,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "# Title\n\nSelected text",
        renderedMarkdownHtml: "<h1>Title</h1><p>Selected text</p>",
      })),
    };

    try {
      render(
        <I18nProvider>
          <FileViewer
            projectId="project-id"
            filePath="notes.md"
            initialPresentation="preview"
            source={source}
            standalone
          />
        </I18nProvider>,
      );

      await screen.findByRole("heading", { name: "Title" });
      const selectAll = screen.getByRole("button", { name: "Select all" });
      expect(fireEvent.pointerDown(selectAll)).toBe(false);
      await act(async () => {
        fireEvent.click(selectAll);
      });

      const copyText = await screen.findByRole("button", {
        name: "Copy text",
      });
      fireEvent.mouseMove(copyText);
      expect(document.getSelection()?.toString()).toContain("Title");
      expect(document.getSelection()?.toString()).toContain("Selected text");
    } finally {
      await act(async () => {
        localStorage.removeItem(UI_KEYS.selectionTextCopyActionEnabled);
        invalidateLocalStorageValues(UI_KEYS.selectionTextCopyActionEnabled);
        document.getSelection()?.removeAllRanges();
      });
      if (originalRangeRect) {
        Object.defineProperty(
          Range.prototype,
          "getBoundingClientRect",
          originalRangeRect,
        );
      } else {
        Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
      }
    }
  });

  it("keeps primary Markdown clicks in the viewer and quotes from circles", async () => {
    const onQuoteTextBlock = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 21,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "# Title\n\nSelected text",
        renderedMarkdownHtml: "<h1>Title</h1><p>Selected text</p>",
      })),
    };

    render(
      <I18nProvider>
        <QuoteReplyProvider onQuoteTextBlock={onQuoteTextBlock}>
          <FileViewer
            projectId="project-id"
            filePath="notes.md"
            initialPresentation="preview"
            source={source}
          />
        </QuoteReplyProvider>
      </I18nProvider>,
    );

    const paragraph = await screen.findByText("Selected text");
    const viewerBody = paragraph.closest<HTMLElement>(".file-viewer-body");
    expect(viewerBody?.tabIndex).toBe(-1);

    document.getSelection()?.removeAllRanges();
    fireEvent.pointerDown(paragraph, { button: 0 });
    fireEvent.click(paragraph);

    expect(document.activeElement).toBe(viewerBody);
    expect(onQuoteTextBlock).not.toHaveBeenCalled();
    const pageDown = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "PageDown",
    });
    viewerBody?.dispatchEvent(pageDown);
    expect(pageDown.defaultPrevented).toBe(false);

    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: /Quote this paragraph/ }),
      ).toHaveLength(2),
    );
    const quoteButtons = screen.getAllByRole("button", {
      name: /Quote this paragraph/,
    });
    fireEvent.click(quoteButtons[1]!);

    expect(onQuoteTextBlock).toHaveBeenCalledTimes(1);
    expect(onQuoteTextBlock.mock.calls[0]?.[0]).toMatchObject({
      quotedText: "> Selected text",
      selectedText: "Selected text",
    });
  });

  it("uses one whole-document quote circle in block-only mode", async () => {
    setQuoteReplyButtonModePreference("block");
    const onQuoteTextBlock = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 21,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "# Title\n\nSelected text",
        renderedMarkdownHtml: "<h1>Title</h1><p>Selected text</p>",
      })),
    };

    render(
      <I18nProvider>
        <QuoteReplyProvider onQuoteTextBlock={onQuoteTextBlock}>
          <FileViewer
            projectId="project-id"
            filePath="notes.md"
            initialPresentation="preview"
            source={source}
          />
        </QuoteReplyProvider>
      </I18nProvider>,
    );

    await screen.findByText("Selected text");
    const quoteButtons = screen.getAllByRole("button", {
      name: /Quote this paragraph/,
    });
    expect(quoteButtons).toHaveLength(1);
    expect(quoteButtons[0]?.classList).toContain("text-block-quote-fallback");
    fireEvent.click(quoteButtons[0]!);
    expect(onQuoteTextBlock).toHaveBeenCalledTimes(1);
    const anchor = onQuoteTextBlock.mock.calls[0]?.[0];
    expect(anchor?.quotedText).toContain("# Title");
    expect(anchor?.quotedText).toContain("Selected text");
    expect(anchor?.selectedText).not.toContain(">");
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
    const viewerBody =
      container.querySelector<HTMLElement>(".file-viewer-body");
    await waitFor(() =>
      expect(viewerBody?.getAttribute("data-markdown-copy-source")).toBe(
        "true",
      ),
    );
    const range = document.createRange();
    range.selectNodeContents(includePath);
    const selection = document.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);

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

    const rawSource = await screen.findByRole("button", {
      name: "Raw source",
    });
    expect(rawSource.getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.getByText(/Preview heading/)).toBeTruthy();

    fireEvent.click(rawSource);
    const frame = container.querySelector<HTMLIFrameElement>("iframe");
    expect(frame).toBeTruthy();
    expect(rawSource.getAttribute("aria-pressed")).toBe("false");
    expect(frame?.getAttribute("sandbox")).toBe("");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.srcdoc).toContain("Content-Security-Policy");
    expect(frame?.srcdoc).toContain("default-src 'none'");
    expect(document.body.dataset.pwned).toBeUndefined();

    fireEvent.click(rawSource);
    expect(container.querySelector("iframe")).toBeNull();
    expect(rawSource.getAttribute("aria-pressed")).toBe("true");
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
    expect(
      screen
        .getByRole("button", { name: "Raw source" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
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
    const image = await screen.findByRole("img", { name: "result.png" });
    expect(image.getAttribute("src")).toBe("blob:file-viewer-image");
    fireEvent.contextMenu(image);
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

    const openLink = container.querySelector<HTMLAnchorElement>(
      '.file-viewer-actions .file-viewer-action[title="Open image in new tab"]',
    );
    expect(openLink?.getAttribute("href")).toBe(
      "/api/projects/project-id/files/raw?path=screenshots%2Fresult.png",
    );
    expect(openLink?.getAttribute("target")).toBe("_blank");
    expect(openLink?.getAttribute("rel")).toBe("noopener noreferrer");
    expect(openMock).not.toHaveBeenCalled();
  });

  it("sends source-line comments without using the paragraph quote rail", async () => {
    const onSendComment = vi.fn(async () => true);
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "src/example.ts",
          size: 34,
          mimeType: "text/typescript",
          isText: true,
        },
        rawUrl: "",
        content: "const first = 1;\nconst second = 2;\nreturn first;",
        highlightedHtml:
          '<pre class="shiki"><code><span class="line">const first = 1;</span>\n<span class="line">const second = 2;</span>\n<span class="line">return first;</span></code></pre>',
      })),
    };
    const projectId = toUrlProjectId("/workspace");
    const { container } = render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId={projectId}
          projectPath="/workspace"
          sessionId="session-id"
        >
          <SessionViewerCommentProvider onSendComment={onSendComment}>
            <QuoteReplyProvider onQuoteTextBlock={vi.fn()}>
              <FileViewer
                projectId={projectId}
                filePath="src/example.ts"
                source={source}
                onClose={vi.fn()}
              />
            </QuoteReplyProvider>
          </SessionViewerCommentProvider>
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    const toggle = await screen.findByRole("button", { name: "Comment" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.queryByRole("button", { name: /Quote this paragraph/ }),
    ).toBeNull();

    const secondLine = container.querySelector<HTMLElement>('[data-line="2"]');
    expect(secondLine).toBeTruthy();
    fireEvent.click(secondLine!);
    const editor = await screen.findByPlaceholderText(
      "Comment or ask a question…",
    );
    expect(screen.getByText("src/example.ts:2")).toBeTruthy();
    fireEvent.change(editor, {
      target: { value: "Should these share a name?" },
    });
    fireEvent.keyDown(editor, { key: "Enter", shiftKey: true });
    expect(onSendComment).not.toHaveBeenCalled();
    fireEvent.keyDown(editor, { key: "Enter" });

    await waitFor(() =>
      expect(onSendComment).toHaveBeenCalledWith(
        "src/example.ts:2\n\n> const first = 1;\n> const second = 2;\n> return first;\n\nShould these share a name?",
      ),
    );
    await waitFor(() => expect(editor.isConnected).toBe(false));
  });

  it("flushes unsent source comments as one grouped session turn", async () => {
    const onSendComment = vi.fn(async () => true);
    const onClose = vi.fn();
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "src/example.ts",
          size: 13,
          mimeType: "text/typescript",
          isText: true,
        },
        rawUrl: "",
        content: "one\ntwo\nthree",
        highlightedHtml:
          '<pre class="shiki"><code><span class="line">one</span>\n<span class="line">two</span>\n<span class="line">three</span></code></pre>',
      })),
    };
    const projectId = toUrlProjectId("/workspace");
    const { container } = render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId={projectId}
          projectPath="/workspace"
          sessionId="session-id"
        >
          <SessionViewerCommentProvider onSendComment={onSendComment}>
            <FileViewer
              projectId={projectId}
              filePath="src/example.ts"
              source={source}
              onClose={onClose}
            />
          </SessionViewerCommentProvider>
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    fireEvent.click(container.querySelector<HTMLElement>('[data-line="1"]')!);
    fireEvent.change(
      await screen.findByPlaceholderText("Comment or ask a question…"),
      { target: { value: "First comment" } },
    );
    fireEvent.click(container.querySelector<HTMLElement>('[data-line="3"]')!);
    fireEvent.change(
      await screen.findByPlaceholderText("Comment or ask a question…"),
      { target: { value: "Second comment" } },
    );
    fireEvent.click(screen.getByTitle("Close"));

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(onSendComment).toHaveBeenCalledTimes(1));
    expect(onSendComment).toHaveBeenCalledWith(
      "src/example.ts:1\n\n> one\n> two\n> three\n\nFirst comment\n\n---\n\nsrc/example.ts:3\n\n> one\n> two\n> three\n\nSecond comment",
    );
  });

  it("opens the comment composer from a rendered-text selection", async () => {
    const onSendComment = vi.fn(async () => true);
    const source: FileViewerSource = {
      loadFile: vi.fn(async () => ({
        metadata: {
          path: "notes.md",
          size: 22,
          mimeType: "text/markdown",
          isText: true,
        },
        rawUrl: "",
        content: "# Title\n\nSelected words",
        renderedMarkdownHtml: "<h1>Title</h1><p>Selected words</p>",
      })),
    };
    const projectId = toUrlProjectId("/workspace");
    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId={projectId}
          projectPath="/workspace"
          sessionId="session-id"
        >
          <SessionViewerCommentProvider onSendComment={onSendComment}>
            <QuoteReplyProvider onQuoteTextBlock={vi.fn()}>
              <FileViewer
                projectId={projectId}
                filePath="notes.md"
                initialPresentation="preview"
                source={source}
                onClose={vi.fn()}
              />
            </QuoteReplyProvider>
          </SessionViewerCommentProvider>
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Comment" }));
    const selectedText = screen.getByText("Selected words");
    const range = document.createRange();
    range.selectNodeContents(selectedText);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    act(() => document.dispatchEvent(new Event("selectionchange")));

    const editor = await screen.findByPlaceholderText(
      "Comment or ask a question…",
    );
    expect(editor).toBeTruthy();
    expect(screen.getByText("notes.md:3")).toBeTruthy();
    const selectedCopies = screen.getAllByText("Selected words");
    expect(selectedCopies.length).toBeGreaterThan(1);
    const renderedSelection = selectedCopies.find(
      (element) => element.tagName === "P",
    );
    expect(renderedSelection?.nextElementSibling?.contains(editor)).toBe(true);
    expect(editor.closest("[data-review-comment-inline]")).toBeTruthy();
    expect(document.activeElement).not.toBe(editor);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(editor.isConnected).toBe(false));
    expect(onSendComment).not.toHaveBeenCalled();
  });
});
