// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { useExpandedDiff } from "../useExpandedDiff";

const mocks = vi.hoisted(() => ({
  getFile: vi.fn(),
  expandDiffContext: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getFile: mocks.getFile,
    expandDiffContext: mocks.expandDiffContext,
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SessionMetadataProvider
      projectId="project-1"
      projectPath="/repo"
      sessionId="session-1"
    >
      {children}
    </SessionMetadataProvider>
  );
}

describe("useExpandedDiff", () => {
  beforeEach(() => {
    mocks.getFile.mockReset();
    mocks.expandDiffContext.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("uses the SDK snapshot without reading the current file", async () => {
    mocks.expandDiffContext.mockResolvedValue({
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] },
      ],
      diffHtml: "<pre></pre>",
    });

    const { result } = renderHook(
      () =>
        useExpandedDiff({
          filePath: "a.ts",
          oldString: "old",
          newString: "new",
          originalFile: "old\n",
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.fetchExpandedDiff();
    });

    expect(mocks.getFile).not.toHaveBeenCalled();
    expect(mocks.expandDiffContext).toHaveBeenCalledWith(
      "project-1",
      "a.ts",
      "old",
      "new",
      "old\n",
    );
    expect(result.current.result).toEqual({
      kind: "diff",
      structuredPatch: [
        { oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["+x"] },
      ],
      diffHtml: "<pre></pre>",
    });
  });

  it("returns the current file when the replacement cannot be identified", async () => {
    mocks.getFile.mockResolvedValue({
      metadata: {
        path: "a.ts",
        size: 9,
        mimeType: "text/plain",
        isText: true,
      },
      rawUrl: "",
      content: "unrelated",
    });

    const { result } = renderHook(
      () =>
        useExpandedDiff({
          filePath: "a.ts",
          oldString: "old",
          newString: "new",
          originalFile: "",
        }),
      { wrapper },
    );

    await act(async () => {
      await result.current.fetchExpandedDiff();
    });

    expect(mocks.expandDiffContext).not.toHaveBeenCalled();
    expect(result.current.result).toEqual({
      kind: "file",
      content: "unrelated",
    });
  });
});
