// @vitest-environment jsdom

import type { ToolResultMedia } from "@yep-anywhere/shared";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../../contexts/SessionMetadataContext";
import { setInlineMediaExpandedPreference } from "../../../hooks/useInlineMedia";
import { I18nProvider } from "../../../i18n";
import { asClientSummarySourceKey } from "../../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../../lib/transport";
import {
  getToolResultImageSourcePath,
  ToolResultMediaRows,
} from "../ToolResultMediaRows";

const STORED_MEDIA: ToolResultMedia[] = [
  {
    state: "stored",
    toolCallId: "tool-media",
    id: "media-a",
    mimeType: "image/png",
    byteLength: 128,
    width: 640,
    height: 480,
    filename: "first.png",
  },
  {
    state: "stored",
    toolCallId: "tool-media",
    id: "media-b",
    mimeType: "image/png",
    byteLength: 256,
    width: 320,
    height: 200,
    filename: "second.png",
  },
];

function createRuntime(transport: FakeSourceTransport): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey("test:tool-result-media"),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

function renderRows(
  media: ToolResultMedia[],
  transport: FakeSourceTransport,
  sourcePath?: string,
) {
  return render(
    <I18nProvider>
      <SourceRuntimeProvider runtime={createRuntime(transport)}>
        <SessionMetadataProvider
          projectId="project/id"
          projectPath="/project"
          sessionId="session id"
        >
          <ToolResultMediaRows
            displayName="Viewed"
            media={media}
            sourcePath={sourcePath}
            status="complete"
          />
        </SessionMetadataProvider>
      </SourceRuntimeProvider>
    </I18nProvider>,
  );
}

describe("ToolResultMediaRows", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:tool-result"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    act(() => setInlineMediaExpandedPreference(false));
  });

  afterEach(() => {
    cleanup();
    act(() => setInlineMediaExpandedPreference(false));
    vi.restoreAllMocks();
  });

  for (const transportCase of [
    { name: "direct", kind: "localhost" as const, sameOriginUrls: true },
    { name: "relay", kind: "secure" as const, sameOriginUrls: false },
  ]) {
    it(`fetches an expanded row through the ${transportCase.name} transport`, async () => {
      const fetchBlob = vi.fn(
        async () => new Blob(["png"], { type: "image/png" }),
      );
      const transport = new FakeSourceTransport({
        kind: transportCase.kind,
        capabilities: { sameOriginUrls: transportCase.sameOriginUrls },
        fetchBlob,
      });
      renderRows(STORED_MEDIA, transport);

      expect(fetchBlob).not.toHaveBeenCalled();
      const toggles = screen.getAllByRole("button", {
        name: "Expand image preview",
      });
      fireEvent.click(toggles[0] as HTMLElement);

      await waitFor(() => {
        expect(fetchBlob).toHaveBeenCalledWith(
          "/projects/project%2Fid/sessions/session%20id/media/media-a",
        );
      });
      expect(fetchBlob).toHaveBeenCalledTimes(1);
      expect(
        await screen.findByRole("img", { name: "first.png tool result" }),
      ).toBeTruthy();
      expect(
        screen.getByRole("button", { name: "Expand image preview" }),
      ).toBeTruthy();
    });
  }

  it("uses the setting only as each row's initial expansion state", async () => {
    setInlineMediaExpandedPreference(true);
    const fetchBlob = vi.fn(
      async () => new Blob(["png"], { type: "image/png" }),
    );
    renderRows(STORED_MEDIA, new FakeSourceTransport({ fetchBlob }));

    await waitFor(() => expect(fetchBlob).toHaveBeenCalledTimes(2));
    const collapseButtons = screen.getAllByRole("button", {
      name: "Collapse image preview",
    });
    fireEvent.click(collapseButtons[0] as HTMLElement);
    expect(
      screen.getAllByRole("button", { name: "Collapse image preview" }),
    ).toHaveLength(1);

    act(() => {
      setInlineMediaExpandedPreference(false);
    });
    expect(
      screen.getAllByRole("button", { name: "Collapse image preview" }),
    ).toHaveLength(1);
  });

  it("shows rejected media explicitly without fetching", () => {
    const fetchBlob = vi.fn();
    renderRows(
      [
        {
          state: "rejected",
          toolCallId: "tool-media",
          reason: "unsupported-media",
          filename: "vector.svg",
        },
      ],
      new FakeSourceTransport({ fetchBlob }),
    );

    expect(screen.getByText("vector.svg")).toBeTruthy();
    expect(screen.getByText("(image unavailable)")).toBeTruthy();
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it("offers image and semantic path actions from the filename", () => {
    const transport = new FakeSourceTransport({
      fetchBlob: vi.fn(async () => new Blob(["png"], { type: "image/png" })),
    });
    renderRows(
      [STORED_MEDIA[0] as ToolResultMedia],
      transport,
      "/project/captures/first.png",
    );

    fireEvent.contextMenu(screen.getByRole("button", { name: "first.png" }));
    expect(
      screen.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual(["Open", "Download", "Copy›"]);
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

  it("uses a tool-input path only for a single path-backed image", () => {
    expect(
      getToolResultImageSourcePath(
        "ViewImage",
        { path: "/tmp/capture.png" },
        1,
      ),
    ).toBe("/tmp/capture.png");
    expect(
      getToolResultImageSourcePath(
        "Read",
        { file_path: "captures/first.png" },
        1,
      ),
    ).toBe("captures/first.png");
    expect(
      getToolResultImageSourcePath(
        "ViewImage",
        { path: "/tmp/capture.png" },
        2,
      ),
    ).toBeUndefined();
    expect(
      getToolResultImageSourcePath(
        "GenerateImage",
        { path: "/tmp/capture.png" },
        1,
      ),
    ).toBeUndefined();
  });
});
