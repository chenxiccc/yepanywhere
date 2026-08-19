// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../lib/transport";
import { AttachmentChip, HOVER_PREVIEW_LINGER_MS } from "../AttachmentChip";

function createRuntime(): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey("test:attachment-chip"),
    transport: new FakeSourceTransport({
      capabilities: { sameOriginUrls: true },
    }),
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <SourceRuntimeProvider runtime={createRuntime()}>
      <I18nProvider>{children}</I18nProvider>
    </SourceRuntimeProvider>
  );
}

describe("AttachmentChip hover preview", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows a full-size preview from the local object URL after linger", () => {
    render(
      <Wrapper>
        <AttachmentChip
          originalName="image.png"
          mimeType="image/png"
          sizeLabel="101 kb"
          imageWidth={759}
          imageHeight={668}
          previewUrl="blob:local-preview"
        />
      </Wrapper>,
    );

    fireEvent.mouseEnter(
      screen.getByRole("button", { name: "Open image.png" }),
    );
    expect(screen.queryByTestId("attachment-hover-preview")).toBeNull();

    act(() => {
      vi.advanceTimersByTime(HOVER_PREVIEW_LINGER_MS);
    });

    const preview = screen.getByTestId("attachment-hover-preview");
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(
      "blob:local-preview",
    );
  });
});
