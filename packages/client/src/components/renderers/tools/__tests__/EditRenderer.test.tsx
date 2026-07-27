import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { SessionMetadataProvider } from "../../../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../../../i18n";
import { UI_KEYS } from "../../../../lib/storageKeys";
import { editRenderer } from "../EditRenderer";

vi.mock("../../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
    ignoreToolErrors: vi.fn(),
    clearIgnoredTools: vi.fn(),
    ignoredTools: [],
  }),
}));

const renderContext = {
  isStreaming: false,
  theme: "dark" as const,
};
if (!editRenderer.renderCollapsedPreview) {
  throw new Error("Edit renderer must provide collapsed preview");
}
const renderCollapsedPreview = editRenderer.renderCollapsedPreview;

function LocationStateProbe() {
  const location = useLocation();
  return (
    <pre data-testid="location-state">
      {JSON.stringify({ pathname: location.pathname, state: location.state })}
    </pre>
  );
}

describe("EditRenderer collapsed preview fallback", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "themed");
  });

  afterEach(() => {
    document.getSelection()?.removeAllRanges();
    cleanup();
    vi.unstubAllGlobals();
    window.localStorage.removeItem(UI_KEYS.tooltipMode);
  });

  it("renders raw patch text for completed rows when structured patch is missing", () => {
    const input = {
      _rawPatch: [
        "*** Begin Patch",
        "*** Update File: src/example.ts",
        "@@",
        "-const x = 1;",
        "+const x = 2;",
        "*** End Patch",
      ].join("\n"),
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText(/\*\*\* Begin Patch/)).toBeDefined();
  });

  it("keeps pending classic Edit rows on Computing diff...", () => {
    const input = {
      file_path: "src/example.ts",
      old_string: "const x = 1;",
      new_string: "const x = 2;",
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Computing diff...")).toBeDefined();
  });

  it("keeps structured diff rendering unchanged when structured patch exists", () => {
    const input = {
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
    };

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText("-const x = 1;")).toBeDefined();
    expect(screen.getByText("+const x = 2;")).toBeDefined();
  });

  it("reveals the omitted Edit tail from the fade and +N badge", () => {
    const lines = Array.from(
      { length: 16 },
      (_, index) => `+line ${index + 1}`,
    );
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines,
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          { _structuredPatch: structuredPatch } as never,
          {
            filePath: "notes.txt",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    const badge = container.querySelector<HTMLElement>(".edit-preview-more");
    const fadedPreview = container.querySelector<HTMLElement>(
      ".diff-view-container",
    );
    expect(badge?.textContent).toBe("+4");
    expect(badge?.getAttribute("data-tooltip")).toBe(
      "...\n+line 5\n+line 6\n+line 7\n+line 8\n+line 9\n+line 10\n+line 11\n+line 12\n+line 13\n+line 14\n+line 15\n+line 16",
    );
    expect(fadedPreview?.getAttribute("data-tooltip")).toBe(
      badge?.getAttribute("data-tooltip"),
    );
    expect(badge?.getAttribute("title")).toBeNull();
    expect(fadedPreview?.getAttribute("title")).toBeNull();
  });

  it("uses only native attributes for an Edit tail in native mode", () => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "native");
    const lines = Array.from(
      { length: 13 },
      (_, index) => `+line ${index + 1}`,
    );
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines,
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          { _structuredPatch: structuredPatch } as never,
          {
            filePath: "notes.txt",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    const badge = container.querySelector<HTMLElement>(".edit-preview-more");
    expect(badge?.getAttribute("title")).toMatch(/^\.\.\.\n\+line 2/);
    expect(badge?.getAttribute("data-tooltip")).toBeNull();
  });

  it("shows a full unfaded Edit preview when it is off-screen", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: ["+line 1"],
      },
    ];
    const { container } = render(
      <div>
        {renderCollapsedPreview(
          { _structuredPatch: structuredPatch } as never,
          {
            filePath: "notes.txt",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(container.querySelector(".edit-preview-more")).toBeNull();
    const preview = container.querySelector<HTMLElement>(
      ".diff-view-container",
    );
    expect(preview).toBeTruthy();
    expect(preview?.classList).not.toContain("truncated");
    Object.defineProperties(preview, {
      clientWidth: { configurable: true, value: 300 },
      clientHeight: { configurable: true, value: 20 },
      scrollWidth: { configurable: true, value: 300 },
      scrollHeight: { configurable: true, value: 20 },
      getBoundingClientRect: {
        configurable: true,
        value: () => ({
          x: 0,
          y: window.innerHeight - 10,
          left: 0,
          top: window.innerHeight - 10,
          right: 300,
          bottom: window.innerHeight + 10,
          width: 300,
          height: 20,
          toJSON: () => ({}),
        }),
      },
    });

    fireEvent.pointerEnter(preview as HTMLElement);

    expect(preview?.getAttribute("data-tooltip")).toContain("+line 1");
    expect(preview?.getAttribute("title")).toBeNull();
  });

  it("renders completed markdown table edits through the render toggle", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 3,
        newStart: 1,
        newLines: 3,
        lines: [
          " | name | value |",
          " | --- | --- |",
          "-| old | $x^2$ |",
          "+| new | $y^2$ |",
        ],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("old")).toBeDefined();
    expect(screen.getByText("new")).toBeDefined();
    expect(container.querySelector(".katex")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Show source" }));

    expect(container.textContent).toContain("-| old | $x^2$ |");
  });

  it("renders markdown headings and inline markup in completed edits", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 2,
        lines: ["-old text", "+## Findings", "+- **win** in `dev`"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("Findings")).toBeDefined();
    expect(
      container.querySelector(".fixed-font-markdown-heading"),
    ).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
    expect(container.querySelector("code")?.textContent).toBe("dev");
    const gutters = Array.from(
      container.querySelectorAll(".fixed-font-diff-gutter"),
    ).map((node) => node.textContent);
    expect(gutters).toContain("+");
    expect(gutters).toContain("-");
  });

  it("does not markdown-render backticks in non-Markdown edits", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-const label = `old`;", "+const label = `dev`;"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "Widget.tsx",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("+const label = `dev`;")).toBeDefined();
    expect(
      container.querySelector(".fixed-font-rendered__content code"),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Show source" })).toBeNull();
  });

  it("renders headerless markdown table edit hunks", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [
          "@@ -1,2 +1,3 @@",
          "-| `POL-E2P-Q35-BASE` | `en->pl` | Qwen3.5-4B base | 200 | 3.1581 | 290.64 tok/s / 7,598 tok |",
          "-| `POL-E2P-TG4B-BASE` | `en->pl` | TranslateGemma-4B base | 200 | **2.7577** | 235.79 tok/s / 7,726 tok |",
          "+| `POL-E2P-EURO-BASE` | `en->pl` | EuroLLM-9B base | 200 | **2.5526** | 98.89 tok/s / 6,527 tok |",
          "+| `POL-E2P-Q35-BASE` | `en->pl` | Qwen3.5-4B base | 200 | 3.1581 | 290.64 tok/s / 7,598 tok |",
          "+| `POL-E2P-TG4B-BASE` | `en->pl` | TranslateGemma-4B base | 200 | 2.7577 | 235.79 tok/s / 7,726 tok |",
        ],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "research/conditioned-diversity.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("table")).toBeDefined();
    expect(screen.getByText("POL-E2P-EURO-BASE")).toBeDefined();
    expect(
      Array.from(container.querySelectorAll("strong")).map(
        (node) => node.textContent,
      ),
    ).toContain("2.5526");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(5);
  });

  it("resolves markdown links in edit table cells relative to the edited file", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 3,
        lines: [
          "+| Ref | Artifacts |",
          "+| --- | --- |",
          "+| `PILOT` | [decode](../untracked/pilot.meta.md) |",
        ],
      },
    ];

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "research/conditioned-diversity.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </SessionMetadataProvider>,
    );

    const link = screen.getByRole("link", { name: "decode" });
    expect(link.getAttribute("data-fixed-font-file-path")).toBe(
      "untracked/pilot.meta.md",
    );
  });

  it("renders server-provided highlighted diff HTML when available", () => {
    const input = {
      _structuredPatch: [
        {
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: ["-const x = 1;", "+const x = 2;"],
        },
      ],
      _diffHtml:
        '<pre class="shiki"><code class="language-ts"><span class="line line-deleted"><span class="diff-prefix">-</span><span style="color:var(--shiki-token-keyword)">const</span> x = 1;</span>\n<span class="line line-inserted"><span class="diff-prefix">+</span><span style="color:var(--shiki-token-keyword)">const</span> x = 2;</span></code></pre>',
    };

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(
      container.querySelector(".highlighted-diff .line-inserted"),
    ).toBeTruthy();
    expect(screen.getAllByText(/const/)).toHaveLength(2);
  });

  it("renders stable fallback text when completed row has no patch data", () => {
    const input = {};

    render(
      <div>
        {renderCollapsedPreview(
          input as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText("Computing diff...")).toBeNull();
    expect(screen.getByText("Patch preview unavailable")).toBeDefined();
  });

  it("derives filename from raw patch when file_path is missing", () => {
    const summary = editRenderer.getUseSummary?.({
      _rawPatch: [
        "*** Begin Patch",
        "*** Update File: packages/client/src/components/Foo.tsx",
        "@@",
        "-const x = 1;",
        "+const x = 2;",
        "*** End Patch",
      ].join("\n"),
    } as never);

    expect(summary).toBe("Foo.tsx");
  });

  it("summarizes multi-file raw Codex patches without implying the previous read", () => {
    const summary = editRenderer.getUseSummary?.(
      [
        "*** Begin Patch",
        "*** Update File: RegressionTests/AwesomeAlign/regtest-awesome-chi.yml",
        "@@",
        "+# checked chi",
        "*** Update File: RegressionTests/AwesomeAlign/regtest-xmt-awesomealign.yml",
        "@@",
        "+# checked align",
        "*** End Patch",
      ].join("\n") as never,
    );

    expect(summary).toBe("regtest-awesome-chi.yml +1 files");
  });

  it("summarizes Codex fileChange inputs from changed paths", () => {
    const summary = editRenderer.getUseSummary?.({
      changes: [
        {
          path: "/repo/src/a.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-a\n+b\n",
        },
        {
          path: "/repo/src/b.ts",
          kind: "update",
          diff: "@@ -1 +1 @@\n-c\n+d\n",
        },
      ],
    } as never);

    expect(summary).toBe("a.ts +1 files");
  });

  it("keeps completed apply_patch summaries specific before rich hydration", () => {
    const summary = editRenderer.getResultSummary?.(
      { ok: true } as never,
      false,
      [
        "*** Begin Patch",
        "*** Update File: src/a.ts",
        "@@",
        "+const a = 1;",
        "*** Update File: src/b.ts",
        "@@",
        "+const b = 1;",
        "*** End Patch",
      ].join("\n") as never,
    );

    expect(summary).toBe("a.ts +1 files");
  });

  it("shows raw patch filename in interactive summary when file_path is missing", () => {
    if (!editRenderer.renderInteractiveSummary) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <div>
        {editRenderer.renderInteractiveSummary(
          {
            _rawPatch: [
              "*** Begin Patch",
              "*** Update File: packages/client/src/components/Foo.tsx",
              "@@",
              "-const x = 1;",
              "+const x = 2;",
              "*** End Patch",
            ].join("\n"),
            _structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const x = 1;", "+const x = 2;"],
              },
            ],
          } as never,
          undefined,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByRole("button", { name: /Foo\.tsx/i })).toBeDefined();
  });

  it("links an Edit block to its dirty file with this session as the default", async () => {
    if (!editRenderer.renderInteractiveSummary) {
      throw new Error("Edit renderer must provide interactive summary");
    }
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-const x = 1;", "+const x = 2;"],
      },
    ];

    render(
      <MemoryRouter initialEntries={["/projects/project-1/sessions/session-1"]}>
        <SessionMetadataProvider
          projectId="project-1"
          projectPath="/repo"
          sessionId="session-1"
          sessionTitle="Fix polling"
          provider="codex"
          model="gpt-5.4"
          thinking={{ type: "adaptive", display: "summarized" }}
          effort="high"
        >
          <I18nProvider>
            <Routes>
              <Route
                path="/projects/:projectId/sessions/:sessionId"
                element={editRenderer.renderInteractiveSummary(
                  {
                    file_path: "/repo/src/example.ts",
                    _structuredPatch: structuredPatch,
                  } as never,
                  undefined,
                  false,
                  renderContext,
                )}
              />
              <Route path="/git-status" element={<LocationStateProbe />} />
            </Routes>
          </I18nProvider>
        </SessionMetadataProvider>
      </MemoryRouter>,
    );

    const link = screen.getByRole("link", { name: "Review dirty file" });
    expect(link.getAttribute("href")).toBe(
      "/git-status?projectId=project-1&worktreeFile=src%2Fexample.ts",
    );
    fireEvent.click(link);

    const route = JSON.parse(
      (await screen.findByTestId("location-state")).textContent ?? "{}",
    ) as {
      pathname: string;
      state: unknown;
    };
    expect(route).toEqual({
      pathname: "/git-status",
      state: {
        defaultSession: {
          projectId: "project-1",
          id: "session-1",
          title: "Fix polling",
          newSession: {
            provider: "codex",
            model: "gpt-5.4",
            thinking: { type: "adaptive", display: "summarized" },
            effort: "high",
          },
        },
      },
    });
  });

  it("puts all multi-file patch targets in the interactive summary title", () => {
    if (!editRenderer.renderInteractiveSummary) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        {editRenderer.renderInteractiveSummary(
          {
            _rawPatch: [
              "*** Begin Patch",
              "*** Update File: /repo/src/a.ts",
              "@@",
              "+const a = 1;",
              "*** Update File: /repo/src/b.ts",
              "@@",
              "+const b = 1;",
              "*** End Patch",
            ].join("\n"),
            _structuredPatch: [
              {
                oldStart: 1,
                oldLines: 0,
                newStart: 1,
                newLines: 1,
                lines: ["+const a = 1;"],
              },
            ],
          } as never,
          undefined,
          false,
          renderContext,
        )}
      </SessionMetadataProvider>,
    );

    const button = screen.getByRole("button", { name: /a\.ts \+1 files/i });
    expect(button.getAttribute("title")).toBe("src/a.ts\nsrc/b.ts");
  });

  it("keeps pending multi-file edit summaries title-backed and clickable", () => {
    if (!editRenderer.renderInteractiveSummary) {
      throw new Error("Edit renderer must provide interactive summary");
    }

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          {editRenderer.renderInteractiveSummary(
            {
              _rawPatch: [
                "*** Begin Patch",
                "*** Update File: /repo/src/a.ts",
                "@@",
                "+const a = 1;",
                "*** Update File: /repo/src/b.ts",
                "@@",
                "+const b = 1;",
                "*** End Patch",
              ].join("\n"),
            } as never,
            undefined,
            false,
            renderContext,
          )}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    const button = screen.getByRole("button", { name: /a\.ts \+1 files/i });
    expect(button.getAttribute("title")).toBe("src/a.ts\nsrc/b.ts");

    fireEvent.click(button);

    expect(screen.getAllByTitle("src/a.ts").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("src/b.ts").length).toBeGreaterThan(0);
  });

  it("renders Codex Add File patches as created file content", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        lines: ["+# Recent MT Adapter Progress", "+", "+- **win** in `dev`"],
      },
    ];

    const { container } = render(
      <div>
        {renderCollapsedPreview(
          {
            _rawPatch: [
              "*** Begin Patch",
              "*** Add File: /repo/research/progress-2026-05-18.md",
              "+# Recent MT Adapter Progress",
              "+",
              "+- **win** in `dev`",
              "*** End Patch",
            ].join("\n"),
            _structuredPatch: structuredPatch,
          } as never,
          { ok: true } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.queryByText(/\*\*\* Begin Patch/)).toBeNull();
    expect(screen.getByText("Recent MT Adapter Progress")).toBeDefined();
    expect(
      container.querySelector(".fixed-font-markdown-heading"),
    ).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("win");
    expect(container.querySelector("code")?.textContent).toBe("dev");
  });

  it("copies only post-change diff text from the copy button", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        lines: [" context", "-old", "+new", "+tail"],
      },
    ];

    render(
      <div>
        {renderCollapsedPreview(
          {
            _structuredPatch: structuredPatch,
          } as never,
          {
            filePath: "notes.md",
            structuredPatch,
          } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    fireEvent.click(
      screen.getByRole("button", { name: "Copy post-change text" }),
    );

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("context\nnew\ntail");
    });
  });

  it("opens full add-file modal with a fresh render toggle", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 13,
        lines: [
          "+# Recent MT Adapter Progress",
          "+",
          "+- **win** in `dev`",
          "+- line 4",
          "+- line 5",
          "+- line 6",
          "+- line 7",
          "+- line 8",
          "+- line 9",
          "+- line 10",
          "+- line 11",
          "+- line 12",
          "+- line 13",
        ],
      },
    ];

    const { container } = render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          {renderCollapsedPreview(
            {
              _structuredPatch: structuredPatch,
            } as never,
            {
              filePath: "research/progress-2026-05-18.md",
              structuredPatch,
            } as never,
            false,
            renderContext,
          )}
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    expect(screen.getByText("+1")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Show full diff" }));

    const modal = document.body.querySelector(".modal");
    expect(modal?.textContent).toContain("Recent MT Adapter Progress");
    const titleLink = modal?.querySelector(
      ".modal-title a.file-path-link",
    ) as HTMLAnchorElement | null;
    expect(titleLink?.textContent).toContain("progress-2026-05-18.md");
    expect(titleLink?.getAttribute("href")).toBe(
      "/projects/project-1/file?path=research%2Fprogress-2026-05-18.md&line=1&lineEnd=13",
    );
    const pathLink = screen.getByRole("link", {
      name: /research\/progress-2026-05-18\.md\s*:1-13/,
    });
    expect(pathLink.getAttribute("href")).toBe(
      "/projects/project-1/file?path=research%2Fprogress-2026-05-18.md&line=1&lineEnd=13",
    );
    const modalToggle = modal?.querySelector(
      ".fixed-font-render-toggle__button",
    );
    expect(modalToggle).toBeTruthy();

    fireEvent.click(modalToggle as Element);
    expect(container.textContent).toContain("Recent MT Adapter Progress");
  });

  it("counts only hidden rendered diff lines in the +N badge", () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 13,
        lines: Array.from({ length: 13 }, (_, index) => `+line ${index + 1}`),
      },
    ];

    render(
      <div>
        {editRenderer.renderToolResult(
          { filePath: "notes.md", structuredPatch } as never,
          false,
          renderContext,
        )}
      </div>,
    );

    expect(screen.getByText("+1")).toBeDefined();
    expect(screen.queryByText("+2")).toBeNull();
  });

  it("transfers a diff selection into the full modal", async () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old text", "+selected replacement text"],
      },
    ];

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          <div>
            {renderCollapsedPreview(
              { _structuredPatch: structuredPatch } as never,
              { filePath: "notes.md", structuredPatch } as never,
              false,
              renderContext,
            )}
          </div>
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    const selectedText = screen.getByText("+selected replacement text");
    const textNode = selectedText.firstChild;
    if (!textNode) {
      throw new Error("Expected selectable diff text");
    }
    const range = document.createRange();
    range.setStart(textNode, 1);
    range.setEnd(textNode, "selected replacement".length + 1);
    document.getSelection()?.addRange(range);

    fireEvent.click(selectedText);

    await waitFor(() => {
      const modal = document.body.querySelector(".modal");
      const selection = document.getSelection();
      expect(modal).not.toBeNull();
      expect(selection?.toString()).toBe("selected replacement");
      expect(
        selection?.anchorNode ? modal?.contains(selection.anchorNode) : false,
      ).toBe(true);
    });
  });

  it("opens the full modal in the preview mode before transferring a selection", async () => {
    const structuredPatch = [
      {
        oldStart: 1,
        oldLines: 1,
        newStart: 1,
        newLines: 1,
        lines: ["-old text", "+# Selected heading"],
      },
    ];

    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          <div>
            {renderCollapsedPreview(
              { _structuredPatch: structuredPatch } as never,
              { filePath: "notes.md", structuredPatch } as never,
              false,
              renderContext,
            )}
          </div>
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Show source" }));
    const selectedText = screen.getByText("+# Selected heading");
    const textNode = selectedText.firstChild;
    if (!textNode) {
      throw new Error("Expected selectable source diff text");
    }
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 2);
    document.getSelection()?.removeAllRanges();
    document.getSelection()?.addRange(range);

    fireEvent.click(selectedText);

    await waitFor(() => {
      const modal = document.body.querySelector(".modal");
      const selection = document.getSelection();
      expect(modal).not.toBeNull();
      expect(
        modal?.querySelector(
          '.fixed-font-render-toggle__button[aria-label="Show rendered view"]',
        ),
      ).not.toBeNull();
      expect(selection?.toString()).toBe("+#");
      expect(
        selection?.anchorNode ? modal?.contains(selection.anchorNode) : false,
      ).toBe(true);
    });
  });
});
