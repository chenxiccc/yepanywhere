import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { setStableToolPreviewRenderingPreference } from "../../../hooks/useStableToolPreviewRendering";
import { I18nProvider } from "../../../i18n";
import { extractMarkdownSnippetsFromSelection } from "../../../lib/markdownSelectionCopy";
import { UI_KEYS } from "../../../lib/storageKeys";
import grepStyles from "../../renderers/tools/GrepRenderer.module.css";
import {
  DEFERRED_PREVIEW_HEIGHT,
  estimateDeferredPreviewHeightPx,
  ToolCallRow,
} from "../ToolCallRow";

vi.mock("../../../contexts/SchemaValidationContext", () => ({
  useSchemaValidationContext: () => ({
    enabled: false,
    reportValidationError: vi.fn(),
    isToolIgnored: vi.fn(() => false),
  }),
}));

function selectElementText(element: Element) {
  const textNode = document
    .createTreeWalker(element, NodeFilter.SHOW_TEXT)
    .nextNode();
  expect(textNode).toBeTruthy();
  const range = document.createRange();
  range.selectNodeContents(textNode as Node);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function setElementBox(
  element: HTMLElement,
  {
    clientHeight = 20,
    clientWidth,
    scrollHeight = clientHeight,
    scrollWidth = clientWidth,
    top = 0,
  }: {
    clientHeight?: number;
    clientWidth: number;
    scrollHeight?: number;
    scrollWidth?: number;
    top?: number;
  },
) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    clientHeight: { configurable: true, value: clientHeight },
    scrollWidth: { configurable: true, value: scrollWidth },
    scrollHeight: { configurable: true, value: scrollHeight },
  });
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: top,
    left: 0,
    top,
    right: clientWidth,
    bottom: top + clientHeight,
    width: clientWidth,
    height: clientHeight,
    toJSON: () => ({}),
  });
}

describe("ToolCallRow", () => {
  beforeEach(() => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "themed");
  });

  afterEach(() => {
    cleanup();
    window.getSelection()?.removeAllRanges();
    Reflect.deleteProperty(window, "IntersectionObserver");
    setStableToolPreviewRenderingPreference(true);
    window.localStorage.removeItem(UI_KEYS.stableToolPreviewRendering);
    window.localStorage.removeItem(UI_KEYS.tooltipMode);
  });

  it("keeps pending Codex command rows collapsed without output preview cards", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-1"
        toolName="Bash"
        toolInput={{ command: "npm run test:e2e:pipeline-v2" }}
        status="pending"
        sessionProvider="codex"
      />,
    );

    // Pending rows read in the present tense ("Run"), past tense ("Ran")
    // only once the command has finished.
    expect(screen.getByText("Run")).toBeDefined();
    expect(screen.getByText("npm run test:e2e:pipeline-v2")).toBeDefined();
    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(container.querySelector(".tool-use-expanded")).toBeNull();
  });

  it("shows the provider-reported runtime in the Ran label tooltip", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-elapsed"
        toolName="Bash"
        toolInput={{ command: "sleep 12" }}
        toolResult={{
          content: "ok",
          isError: false,
          structured: {
            stdout: "ok",
            stderr: "",
            interrupted: false,
            isImage: false,
            durationSeconds: 12.5,
          },
        }}
        status="complete"
        startTimestampMs={1_000}
        resultTimestampMs={14_000}
      />,
    );

    const label = container.querySelector<HTMLElement>(".tool-name");
    expect(label).toBeTruthy();
    fireEvent.pointerEnter(label as HTMLElement);
    expect(label?.getAttribute("data-tooltip")).toBe("took 12.5s");
    expect(label?.getAttribute("title")).toBeNull();
  });

  it("does not attach a command tooltip when the full command is visible", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-cmd-title"
        toolName="Bash"
        toolInput={{ command: "sleep 12" }}
        toolResult={{
          content: "ok",
          isError: false,
          structured: {
            stdout: "ok",
            stderr: "",
            interrupted: false,
            isImage: false,
            durationSeconds: 12.5,
          },
        }}
        status="complete"
        startTimestampMs={1_000}
        resultTimestampMs={14_000}
      />,
    );

    const command = container.querySelector<HTMLElement>(
      ".tool-summary-command",
    );
    const commandText = container.querySelector<HTMLElement>(
      ".tool-summary-command-text",
    );
    expect(command).toBeTruthy();
    expect(commandText).toBeTruthy();
    setElementBox(commandText as HTMLElement, { clientWidth: 120 });
    expect(command?.getAttribute("data-tooltip")).toBeNull();
    expect(command?.getAttribute("title")).toBeNull();
    fireEvent.pointerEnter(command as HTMLElement);
    expect(command?.getAttribute("data-tooltip")).toBeNull();
    expect(command?.getAttribute("title")).toBeNull();
  });

  it("shows a full command tooltip when a no-more preview is scroll-clipped", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-cmd-scroll-clipped"
        toolName="Bash"
        toolInput={{ command: "sleep 12" }}
        toolResult={{
          content: "ok",
          isError: false,
          structured: {
            stdout: "ok",
            stderr: "",
            interrupted: false,
            isImage: false,
            durationSeconds: 12.5,
          },
        }}
        status="complete"
      />,
    );

    const command = container.querySelector<HTMLElement>(
      ".tool-summary-command",
    );
    const commandText = container.querySelector<HTMLElement>(
      ".tool-summary-command-text",
    );
    expect(command).toBeTruthy();
    expect(commandText).toBeTruthy();
    setElementBox(commandText as HTMLElement, {
      clientWidth: 60,
      scrollWidth: 120,
    });
    expect(container.querySelector(".tool-summary-command-more")).toBeNull();

    fireEvent.pointerEnter(command as HTMLElement);

    expect(command?.getAttribute("data-tooltip")).toBe("[12.5s] sleep 12");
    expect(command?.getAttribute("title")).toBeNull();
  });

  it("prefixes a truncated command tooltip with the elapsed time", () => {
    const longCommand = Array.from(
      { length: 20 },
      (_, index) => `printf 'command line ${index + 1}'`,
    ).join("\n");
    const { container } = render(
      <ToolCallRow
        id="tool-cmd-title"
        toolName="Bash"
        toolInput={{ command: longCommand }}
        toolResult={{
          content: "ok",
          isError: false,
          structured: {
            stdout: "ok",
            stderr: "",
            interrupted: false,
            isImage: false,
            durationSeconds: 12.5,
          },
        }}
        status="complete"
        startTimestampMs={1_000}
        resultTimestampMs={14_000}
      />,
    );

    const command = container.querySelector<HTMLElement>(
      ".tool-summary-command",
    );
    expect(command?.getAttribute("data-tooltip")).toBe(longCommand);
    expect(command?.getAttribute("title")).toBeNull();
    fireEvent.pointerEnter(command as HTMLElement);
    expect(command?.getAttribute("data-tooltip")).toBe(
      `[12.5s] ${longCommand}`,
    );
  });

  it("shows the last preview-count output lines in a truncated preview tooltip", () => {
    const manyLines = Array.from(
      { length: 57 },
      (_, index) => `line ${index + 1}`,
    ).join("\n");
    const { container } = render(
      <ToolCallRow
        id="tool-preview-title"
        toolName="Bash"
        toolInput={{ command: "cat big.log" }}
        toolResult={{
          content: manyLines,
          isError: false,
          structured: {
            stdout: manyLines,
            stderr: "",
            interrupted: false,
            isImage: false,
            durationSeconds: 12.5,
          },
        }}
        status="complete"
        startTimestampMs={1_000}
        resultTimestampMs={14_000}
      />,
    );

    const preview = container.querySelector<HTMLElement>(
      ".tool-row-collapsed-preview",
    );
    expect(preview).toBeTruthy();
    fireEvent.pointerEnter(preview as HTMLElement);
    const title = preview?.getAttribute("data-tooltip") ?? "";
    expect(preview?.getAttribute("title")).toBeNull();
    // "[Ns] ..." then the last N output lines.
    expect(title.startsWith("[12.5s] ...\n")).toBe(true);
    expect(title.endsWith("\nline 57")).toBe(true);
    expect(title).not.toContain("line 1\n");
  });

  it("shows a full output tooltip when an unfaded preview is off-screen", () => {
    const output = "one short line";
    const { container } = render(
      <ToolCallRow
        id="tool-preview-viewport-clipped"
        toolName="Bash"
        toolInput={{ command: "printf output" }}
        toolResult={{
          content: output,
          isError: false,
          structured: {
            stdout: output,
            stderr: "",
            interrupted: false,
            isImage: false,
            durationSeconds: 0.1,
          },
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".bash-preview-fade")).toBeNull();
    expect(container.querySelector(".bash-preview-more")).toBeNull();
    const preview = container.querySelector<HTMLElement>(
      ".tool-row-collapsed-preview",
    );
    const renderedOutput = container.querySelector<HTMLElement>(
      ".bash-preview-output pre",
    );
    expect(preview).toBeTruthy();
    expect(renderedOutput).toBeTruthy();
    setElementBox(renderedOutput as HTMLElement, {
      clientWidth: 200,
      top: window.innerHeight - 10,
    });

    fireEvent.pointerEnter(preview as HTMLElement);

    expect(preview?.getAttribute("data-tooltip")).toBe(`[0.1s] ${output}`);
    expect(preview?.getAttribute("title")).toBeNull();
  });

  it("falls back to the message-time delta tooltip when no runtime is reported", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-elapsed-delta"
        toolName="Bash"
        toolInput={{ command: "make" }}
        toolResult={{
          content: "ok",
          isError: false,
          structured: {
            stdout: "ok",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
        }}
        status="complete"
        startTimestampMs={1_000}
        resultTimestampMs={9_000}
      />,
    );

    const label = container.querySelector<HTMLElement>(".tool-name");
    fireEvent.pointerEnter(label as HTMLElement);
    expect(label?.getAttribute("data-tooltip")).toBe("took ~8s");
    expect(label?.getAttribute("title")).toBeNull();
  });

  it("shows live elapsed time for a backgrounded running command", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-elapsed-bg"
        toolName="Bash"
        toolInput={{
          command: "sleep 600",
          run_in_background: true,
          _backgroundTaskStatus: "running",
        }}
        toolResult={{
          content: "Command running in background with ID: bxyz123",
          isError: false,
        }}
        status="complete"
        startTimestampMs={Date.now() - 90_000}
      />,
    );

    const label = container.querySelector<HTMLElement>(".tool-name");
    fireEvent.pointerEnter(label as HTMLElement);
    expect(label?.getAttribute("data-tooltip")).toMatch(
      /^running for 1m3[01]s$/,
    );
    expect(label?.getAttribute("title")).toBeNull();
  });

  it("uses only native titles for Ran hints in native mode", () => {
    window.localStorage.setItem(UI_KEYS.tooltipMode, "native");
    const longCommand = Array.from(
      { length: 20 },
      (_, index) => `printf 'command line ${index + 1}'`,
    ).join("\n");
    const { container } = render(
      <ToolCallRow
        id="tool-native-titles"
        toolName="Bash"
        toolInput={{ command: longCommand }}
        toolResult={{
          content: "ok",
          isError: false,
          structured: {
            stdout: "ok",
            stderr: "",
            interrupted: false,
            isImage: false,
            durationSeconds: 12.5,
          },
        }}
        status="complete"
      />,
    );

    const label = container.querySelector<HTMLElement>(".tool-name");
    fireEvent.pointerEnter(label as HTMLElement);
    expect(label?.getAttribute("title")).toBe("took 12.5s");
    expect(label?.getAttribute("data-tooltip")).toBeNull();

    const command = container.querySelector<HTMLElement>(
      ".tool-summary-command",
    );
    expect(command?.getAttribute("title")).toBe(longCommand);
    expect(command?.getAttribute("data-tooltip")).toBeNull();
  });

  it("shows pending pi Bash output previews when live updates attach one", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-pi-bash"
        toolName="Bash"
        toolInput={{
          command: "printf 'partial\\n'",
          _previewResult: {
            stdout: "partial\n",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
        }}
        status="pending"
        sessionProvider="pi"
      />,
    );

    expect(screen.getByText("Run")).toBeDefined();
    const preview = container.querySelector(".tool-row-collapsed-preview");
    expect(preview).not.toBeNull();
    expect(preview?.textContent).toContain("partial");
  });

  it("shows pending Edit targets as title-backed clickable summaries", () => {
    render(
      <SessionMetadataProvider
        projectId="project-1"
        projectPath="/repo"
        sessionId="session-1"
      >
        <I18nProvider>
          <ToolCallRow
            id="tool-pending-edit"
            toolName="apply_patch"
            toolInput={[
              "*** Begin Patch",
              "*** Update File: /repo/src/a.ts",
              "@@",
              "+const a = 1;",
              "*** Update File: /repo/src/b.ts",
              "@@",
              "+const b = 1;",
              "*** End Patch",
            ].join("\n")}
            status="pending"
            sessionProvider="codex"
          />
        </I18nProvider>
      </SessionMetadataProvider>,
    );

    const button = screen.getByRole("button", { name: /a\.ts \+1 files/i });
    expect(button.getAttribute("title")).toBe("src/a.ts\nsrc/b.ts");

    fireEvent.click(button);

    expect(screen.getAllByTitle("src/a.ts").length).toBeGreaterThan(0);
    expect(screen.getAllByTitle("src/b.ts").length).toBeGreaterThan(0);
  });

  it("shows completed Codex Bash markdown output as a renderable preview", () => {
    const output = [
      "diff --git a/notes.md b/notes.md",
      "@@ -1,2 +1,2 @@",
      "-## Old",
      "+## New",
      "+- **done** in `dev`",
    ].join("\n");

    const { container } = render(
      <ToolCallRow
        id="tool-markdown-bash"
        toolName="Bash"
        toolInput={{ command: "git diff -- notes.md" }}
        toolResult={{
          structured: {
            stdout: output,
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: output,
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Ran")).toBeDefined();
    expect(
      container.querySelector(".tool-row-collapsed-preview"),
    ).not.toBeNull();
    expect(screen.getByText("New")).toBeDefined();
    expect(
      container.querySelector(".fixed-font-markdown-heading"),
    ).toBeTruthy();
    expect(container.querySelector("strong")?.textContent).toBe("done");
    expect(
      container.querySelector(".fixed-font-rendered__content code")
        ?.textContent,
    ).toBe("dev");
    expect(container.querySelector(".expand-chevron")).toBeNull();
    expect(screen.getAllByText("git diff -- notes.md")).toHaveLength(1);

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse preview from left gutter" }),
    );

    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand preview" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));

    expect(
      container.querySelector(".tool-row-collapsed-preview"),
    ).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse preview" }));

    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(screen.getByText("git diff -- notes.md")).toBeDefined();
    expect(
      screen.getByRole("button", { name: "Expand preview" }),
    ).toBeDefined();
  });

  it("registers Ran command text as a quoteable selection source", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-quote-command"
        toolName="Bash"
        toolInput={{ command: "echo quote me" }}
        toolResult={{
          structured: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    selectElementText(screen.getByText("echo quote me"));

    expect(extractMarkdownSnippetsFromSelection(container)).toMatchObject([
      {
        markdown: "echo quote me",
        selectedText: "echo quote me",
      },
    ]);
  });

  it("registers Bash output previews as quoteable visible text", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-quote-output"
        toolName="Bash"
        toolInput={{ command: "printf red" }}
        toolResult={{
          structured: {
            stdout: "\x1b[31mred quote\x1b[0m",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: "\x1b[31mred quote\x1b[0m",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    selectElementText(screen.getByText("red quote"));

    expect(extractMarkdownSnippetsFromSelection(container)).toMatchObject([
      {
        markdown: "red quote",
        selectedText: "red quote",
      },
    ]);
  });

  it("keeps no-output Bash rows collapsed but expandable to the command", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-empty-bash"
        toolName="Bash"
        toolInput={{ command: "true" }}
        toolResult={{
          structured: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Ran")).toBeDefined();
    expect(screen.getByText("true")).toBeDefined();
    expect(screen.getByText("(no output)")).toBeDefined();
    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
    expect(container.querySelector(".tool-row-content")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show full command" }),
    ).toBeNull();

    fireEvent.click(screen.getByText("true"));

    const content = container.querySelector(".tool-row-content");
    expect(content).not.toBeNull();
    expect(content?.textContent).toBe("true");
    expect(content?.querySelector(".code-block")?.textContent).toBe("true");
    expect(content?.querySelector(".bash-empty")).toBeNull();
    expect(content?.querySelector(".bash-inline-section-label")).toBeNull();
    expect(screen.getByRole("button", { name: "Collapse" })).toBeDefined();
  });

  it("shows return code suffix for non-zero no-output Bash rows", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-empty-bash-error"
        toolName="Bash"
        toolInput={{ command: "false" }}
        toolResult={{
          structured: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
            exitCode: 7,
          },
          content: "(no output)",
          isError: true,
        }}
        status="error"
        sessionProvider="codex"
      />,
    );

    expect(screen.getByText("Ran")).toBeDefined();
    expect(screen.getByText("false")).toBeDefined();
    const noOutput = screen.getByText("(no output)");
    const exitCode = screen.getByText("rc=7");
    const copyButton = screen.getByRole("button", { name: "Copy command" });
    expect(noOutput.nextElementSibling).toBe(exitCode);
    expect(exitCode.nextElementSibling).toBe(copyButton);
    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));

    expect(
      container.querySelector(".tool-row-content .code-block")?.textContent,
    ).toBe("false");
  });

  it("expands Bash command text without toggling row details", () => {
    const command = `printf '${"x".repeat(180)}'`;
    const { container } = render(
      <ToolCallRow
        id="tool-long-bash"
        toolName="Bash"
        toolInput={{ command }}
        toolResult={{
          structured: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Show full command" }),
    ).toBeNull();

    fireEvent.click(screen.getByText(command));

    expect(
      container.querySelector(".tool-row-content .code-block")?.textContent,
    ).toBe(command);
    expect(container.querySelector(".tool-row-collapsed-preview")).toBeNull();
  });

  it("shows hidden multiline Bash command content before expansion", () => {
    const command = ["printf first", "printf second", "printf third"].join(
      "\n",
    );
    const { container } = render(
      <ToolCallRow
        id="tool-multiline-bash"
        toolName="Bash"
        toolInput={{ command }}
        toolResult={{
          structured: {
            stdout: "",
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Show full command" }),
    ).toBeNull();
    const commandText = container.querySelector(".tool-summary-command-text");
    expect(commandText?.textContent).toContain("printf first");
    expect(commandText?.textContent).toContain("printf second");
    expect(commandText?.textContent).not.toContain("printf third");

    // The hidden-content badge sits on its own line under the Run/Ran
    // label, not inside a nested command button.
    const moreBadge = container.querySelector(".tool-summary-command-more");
    expect(moreBadge?.textContent).toContain("+1");
    expect(commandText?.textContent).not.toContain("+1");

    fireEvent.click(commandText as Element);

    expect(
      container.querySelector(".tool-row-content .code-block")?.textContent,
    ).toBe(command);
  });

  it("uses the timeline dot to expand long Grep summaries", () => {
    const pattern =
      "Ran codex update\\. It completed cleanly and kept the existing session ready for follow-up work\\.";
    const { container } = render(
      <ToolCallRow
        id="tool-grep"
        toolName="Grep"
        toolInput={{ pattern, output_mode: "content" }}
        toolResult={{
          structured: {
            mode: "content",
            filenames: [],
            numFiles: 1,
            content: "log.txt:3:Ran codex update. It completed cleanly",
            matches: [
              {
                filePath: "log.txt",
                lineNumber: 3,
                text: "Ran codex update. It completed cleanly",
              },
            ],
          },
          content: "",
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    expect(
      container.querySelector(`.${grepStyles.summaryPatternFull}`),
    ).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand summary" }));

    expect(
      container.querySelector(`.${grepStyles.summaryPatternFull}`)?.textContent,
    ).toBe(pattern);
    expect(
      screen.getByRole("button", { name: "Collapse summary" }),
    ).toBeDefined();
  });

  it("shows PTY-backed read shell rows inline without requiring expansion", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-pty-read"
        toolName="WriteStdin"
        toolInput={{
          session_id: 37863,
          chars: "",
          linked_tool_name: "Read",
          linked_file_path: "packages/client/src/hooks/useGlobalSessions.ts",
        }}
        toolResult={{
          content:
            "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nline 1\nline 2\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(screen.getByText("Shell")).toBeDefined();
    expect(
      screen.getByRole("button", { name: /useGlobalSessions\.ts/i }),
    ).toBeDefined();
    expect(screen.getByText(/2 lines/)).toBeDefined();
    expect(container.querySelector(".expand-chevron")).toBeNull();
  });

  it("keeps generic shell rows expandable when no inline PTY summary applies", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-pty-generic"
        toolName="WriteStdin"
        toolInput={{ session_id: 37863, chars: "" }}
        toolResult={{
          content:
            "Chunk ID: ff710e\nWall time: 0.0518 seconds\nProcess exited with code 0\nOutput:\nline 1\nline 2\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".expand-chevron")).not.toBeNull();
  });

  it("auto-expands a shell row whose output fits the preview budget", () => {
    // Default output-preview-lines budget is 2; two lines fit.
    const { container } = render(
      <ToolCallRow
        id="tool-pty-short"
        toolName="WriteStdin"
        toolInput={{ session_id: 37863, chars: "" }}
        toolResult={{
          content:
            "Script completed\nWall time 27.0 seconds\nOutput:\n[I]: step=2700\n[I]: step=2800\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(screen.getByText(/step=2700/)).toBeDefined();
    expect(container.querySelector(".expand-chevron")).not.toBeNull();
  });

  it("keeps a single mega-line shell output collapsed (wrapped-line budget)", () => {
    // One logical line, but far wider than the preview budget once wrapped;
    // a newline count alone would call this "1 line" and auto-expand it.
    const megaLine = `{"chunk_id":"b064ba","output":"${"x".repeat(3000)}"}`;
    const { container } = render(
      <ToolCallRow
        id="tool-pty-megaline"
        toolName="WriteStdin"
        toolInput={{ session_id: 37863, chars: "" }}
        toolResult={{
          content: `Script completed\nWall time 27.0 seconds\nOutput:\n${megaLine}`,
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(screen.queryByText(/chunk_id/)).toBeNull();
    expect(screen.getByText(/1 lines/)).toBeDefined();
    expect(container.querySelector(".expand-chevron")).not.toBeNull();
  });

  it("keeps a long shell output collapsed behind its summary", () => {
    const longOutput = Array.from({ length: 30 }, (_, i) => `line ${i}`).join(
      "\n",
    );
    render(
      <ToolCallRow
        id="tool-pty-long"
        toolName="WriteStdin"
        toolInput={{ session_id: 37863, chars: "" }}
        toolResult={{
          content: `Script completed\nWall time 27.0 seconds\nOutput:\n${longOutput}`,
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(screen.queryByText(/line 12/)).toBeNull();
    expect(screen.getByText(/30 lines/)).toBeDefined();
  });

  it("collapses generic expanded tool rows from the left strip", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-glob"
        toolName="Glob"
        toolInput={{ pattern: "**/*.ts" }}
        toolResult={{
          structured: {
            filenames: ["src/file.ts"],
            numFiles: 1,
            durationMs: 12,
            truncated: false,
          },
          content: "src/file.ts",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".glob-result")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand" }));

    expect(container.querySelector(".glob-result")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse expanded tool row" }),
    );

    expect(container.querySelector(".glob-result")).toBeNull();
    expect(screen.getByRole("button", { name: "Expand" })).toBeDefined();
  });

  it("collapses expanded Read rows from the left strip", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-read"
        toolName="Read"
        toolInput={{ file_path: "packages/client/src/file.ts" }}
        toolResult={{
          structured: {
            type: "text",
            file: {
              filePath: "packages/client/src/file.ts",
              content: "line 1\nline 2\nline 3\n",
              numLines: 3,
              startLine: 1,
              totalLines: 3,
            },
          },
          content: "line 1\nline 2\nline 3\n",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".read-text-inline")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Expand inline view" }));

    expect(container.querySelector(".read-text-inline")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse expanded tool row" }),
    );

    expect(container.querySelector(".read-text-inline")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand inline view" }),
    ).toBeDefined();
  });

  it("collapses completed Edit previews from the row outline", () => {
    const { container } = render(
      <ToolCallRow
        id="tool-edit"
        toolName="Edit"
        toolInput={{
          file_path: "packages/client/src/file.ts",
          old_string: "const value = 1;",
          new_string: "const value = 2;",
        }}
        toolResult={{
          structured: {
            filePath: "packages/client/src/file.ts",
            oldString: "const value = 1;",
            newString: "const value = 2;",
            originalFile: "const value = 1;\n",
            replaceAll: false,
            userModified: false,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const value = 1;", "+const value = 2;"],
              },
            ],
          },
          content: "const value = 2;",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".edit-collapsed-preview")).not.toBeNull();
    expect(container.querySelector(".edit-result")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Collapse preview" }));

    expect(container.querySelector(".edit-collapsed-preview")).toBeNull();
    expect(container.querySelector(".edit-result")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Expand preview" }),
    ).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Expand preview" }));

    expect(container.querySelector(".edit-collapsed-preview")).not.toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Collapse preview from left gutter" }),
    );

    expect(container.querySelector(".edit-collapsed-preview")).toBeNull();
    expect(container.querySelector(".edit-result")).toBeNull();

    const header = container.querySelector<HTMLElement>(".tool-row-header");
    expect(header).not.toBeNull();
    if (header) {
      fireEvent.click(header);
    }

    expect(container.querySelector(".edit-collapsed-preview")).not.toBeNull();
  });

  it("focuses the tool row top when expanding long inline content", () => {
    let scrollTop = 40;
    const { container } = render(
      <div data-testid="scroll-container" style={{ overflowY: "auto" }}>
        <ToolCallRow
          id="tool-read-scroll"
          toolName="Read"
          toolInput={{ file_path: "packages/client/src/file.ts" }}
          toolResult={{
            structured: {
              type: "text",
              file: {
                filePath: "packages/client/src/file.ts",
                content: "line\n".repeat(80),
                numLines: 80,
                startLine: 1,
                totalLines: 80,
              },
            },
            content: "line\n".repeat(80),
            isError: false,
          }}
          status="complete"
        />
      </div>,
    );
    const scrollContainer = screen.getByTestId("scroll-container");
    Object.defineProperty(scrollContainer, "scrollTop", {
      configurable: true,
      get: () => scrollTop,
      set: (value) => {
        scrollTop = Number(value);
      },
    });
    scrollContainer.getBoundingClientRect = () =>
      ({
        top: 100,
        bottom: 300,
        left: 0,
        right: 300,
        width: 300,
        height: 200,
        x: 0,
        y: 100,
        toJSON: () => ({}),
      }) as DOMRect;
    const row = container.querySelector<HTMLElement>(".tool-row");
    expect(row).not.toBeNull();
    if (row) {
      row.getBoundingClientRect = () =>
        ({
          top: 220,
          bottom: 260,
          left: 0,
          right: 300,
          width: 300,
          height: 40,
          x: 0,
          y: 220,
          toJSON: () => ({}),
        }) as DOMRect;
    }

    fireEvent.click(screen.getByRole("button", { name: "Expand inline view" }));

    expect(scrollTop).toBe(148);
  });

  it("reserves a bounded deferred preview shell before near-viewport hydration", () => {
    class DeferredIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: DeferredIntersectionObserver,
    });
    setStableToolPreviewRenderingPreference(false);

    const { container } = render(
      <ToolCallRow
        id="tool-deferred-bash"
        toolName="Bash"
        toolInput={{ command: "pnpm test -- --runInBand" }}
        toolResult={{
          structured: {
            stdout: ["# Result", "- **line one**", "- line two"].join("\n"),
            stderr: "",
            interrupted: false,
            isImage: false,
          },
          content: ["# Result", "- **line one**", "- line two"].join("\n"),
          isError: false,
        }}
        status="complete"
        sessionProvider="codex"
      />,
    );

    const shell = container.querySelector<HTMLElement>(
      ".tool-row-deferred-preview",
    );
    expect(shell).not.toBeNull();
    expect(container.querySelector(".bash-collapsed-preview")).toBeNull();
    expect(
      shell?.style.getPropertyValue("--tool-row-deferred-preview-height"),
    ).toMatch(/px$/);
  });

  it("renders completed Edit previews immediately by default", () => {
    class DeferredIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: DeferredIntersectionObserver,
    });

    const { container } = render(
      <ToolCallRow
        id="tool-default-stable-edit"
        toolName="Edit"
        toolInput={{
          file_path: "packages/client/src/file.ts",
          old_string: "const value = 1;",
          new_string: "const value = 2;",
        }}
        toolResult={{
          structured: {
            filePath: "packages/client/src/file.ts",
            oldString: "const value = 1;",
            newString: "const value = 2;",
            originalFile: "const value = 1;\n",
            replaceAll: false,
            userModified: false,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const value = 1;", "+const value = 2;"],
              },
            ],
          },
          content: "const value = 2;",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".tool-row-deferred-preview")).toBeNull();
    expect(container.querySelector(".edit-collapsed-preview")).not.toBeNull();
  });

  it("defers completed Edit previews when stable preview rendering is disabled", () => {
    class DeferredIntersectionObserver {
      observe = vi.fn();
      disconnect = vi.fn();
      unobserve = vi.fn();
    }
    Object.defineProperty(window, "IntersectionObserver", {
      configurable: true,
      value: DeferredIntersectionObserver,
    });
    setStableToolPreviewRenderingPreference(false);

    const { container } = render(
      <ToolCallRow
        id="tool-deferred-edit"
        toolName="Edit"
        toolInput={{
          file_path: "packages/client/src/file.ts",
          old_string: "const value = 1;",
          new_string: "const value = 2;",
        }}
        toolResult={{
          structured: {
            filePath: "packages/client/src/file.ts",
            oldString: "const value = 1;",
            newString: "const value = 2;",
            originalFile: "const value = 1;\n",
            replaceAll: false,
            userModified: false,
            structuredPatch: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: ["-const value = 1;", "+const value = 2;"],
              },
            ],
          },
          content: "const value = 2;",
          isError: false,
        }}
        status="complete"
      />,
    );

    expect(container.querySelector(".edit-collapsed-preview")).toBeNull();
    expect(container.querySelector(".tool-row-deferred-preview")).toBeNull();
  });

  it("estimates deferred Bash preview height from text, width, and max preview cap", () => {
    const short = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "echo ok" },
      result: { stdout: "ok", stderr: "" },
      status: "complete",
      rowWidthPx: 900,
    });
    expect(short).toBe(
      DEFERRED_PREVIEW_HEIGHT.minOutputRowPx +
        DEFERRED_PREVIEW_HEIGHT.previewBorderPx,
    );

    const longLine = "x".repeat(180);
    const wide = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "printf long" },
      result: { stdout: longLine, stderr: "" },
      status: "complete",
      rowWidthPx: 1000,
    });
    const narrow = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "printf long" },
      result: { stdout: longLine, stderr: "" },
      status: "complete",
      rowWidthPx: 240,
    });

    expect(wide).not.toBeNull();
    expect(narrow).not.toBeNull();
    expect(narrow as number).toBeGreaterThan(wide as number);
    expect(narrow as number).toBeLessThanOrEqual(DEFERRED_PREVIEW_HEIGHT.maxPx);

    const huge = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "cat big.log" },
      result: { stdout: `${"line\n".repeat(100)}`, stderr: "" },
      status: "complete",
      rowWidthPx: 900,
    });
    // The cap is the preview-lines setting (4 visual lines by default)
    // times the line height, matching the rendered line-clamp.
    expect(huge).toBe(
      DEFERRED_PREVIEW_HEIGHT.outputRowChromePx +
        4 * DEFERRED_PREVIEW_HEIGHT.outputLineHeightPx +
        DEFERRED_PREVIEW_HEIGHT.previewBorderPx,
    );

    const tall = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "cat big.log" },
      result: { stdout: `${"line\n".repeat(100)}`, stderr: "" },
      status: "complete",
      rowWidthPx: 900,
      previewLineCount: 8,
    });
    expect(tall).toBe(
      DEFERRED_PREVIEW_HEIGHT.outputRowChromePx +
        8 * DEFERRED_PREVIEW_HEIGHT.outputLineHeightPx +
        DEFERRED_PREVIEW_HEIGHT.previewBorderPx,
    );
  });

  it("scales deferred Bash preview height with output typography metrics", () => {
    const output = "x".repeat(260);
    const compact = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "printf long" },
      result: { stdout: output, stderr: "" },
      status: "complete",
      rowWidthPx: 360,
      typography: {
        averageCharWidthPx: 5.5,
        outputLineHeightPx: 14,
        outputRowChromePx: 6,
      },
    });
    const roomy = estimateDeferredPreviewHeightPx({
      toolName: "Bash",
      toolInput: { command: "printf long" },
      result: { stdout: output, stderr: "" },
      status: "complete",
      rowWidthPx: 360,
      typography: {
        averageCharWidthPx: 9,
        outputLineHeightPx: 24,
        outputRowChromePx: 18,
      },
    });

    expect(compact).not.toBeNull();
    expect(roomy).not.toBeNull();
    expect(roomy as number).toBeGreaterThan(compact as number);
  });

  it("does not reserve estimated preview height for rows without a cheap model", () => {
    expect(
      estimateDeferredPreviewHeightPx({
        toolName: "Read",
        toolInput: { file_path: "README.md" },
        result: { content: "body" },
        status: "complete",
        rowWidthPx: 900,
      }),
    ).toBeNull();
  });
});
