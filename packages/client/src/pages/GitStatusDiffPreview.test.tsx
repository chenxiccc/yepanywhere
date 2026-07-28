// @vitest-environment jsdom

import type {
  GitDiffResult,
  GitFileChange,
} from "@yep-anywhere/shared";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const getGitDiff = vi.fn();
const listReviewComments = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    getGitDiff: (...args: unknown[]) => getGitDiff(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
  },
}));
vi.mock("../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

import { GitDiffBody } from "./GitStatusDiffPreview";

const t = (key: string) => key;
const FILE: GitFileChange = {
  path: "src/live.ts",
  status: "M",
  staged: false,
  linesAdded: 1,
  linesDeleted: 0,
};

function result(line: string): GitDiffResult {
  return {
    diffHtml: "",
    structuredPatch: [
      {
        oldStart: 1,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        lines: [`+${line}`],
      },
    ],
  };
}

describe("GitDiffBody", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("reloads open full context when the live diff result changes", async () => {
    const normalResults = [result("diff-a"), result("diff-b")];
    const fullResults = [result("full-a"), result("full-b")];
    getGitDiff.mockImplementation(
      (
        _projectId: string,
        options: {
          fullContext?: boolean;
        },
      ) =>
        Promise.resolve(
          options.fullContext
            ? fullResults.shift()
            : normalResults.shift(),
        ),
    );
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    const rendered = render(
      <MemoryRouter>
        <GitDiffBody
          file={FILE}
          fileKey="src/live.ts:false"
          projectId="p1"
          t={t}
        />
      </MemoryRouter>,
    );
    await screen.findByText("diff-a");

    fireEvent.click(
      screen.getByRole("button", { name: "gitStatusFullContext" }),
    );
    await screen.findByText("full-a");

    rendered.rerender(
      <MemoryRouter>
        <GitDiffBody
          file={{ ...FILE }}
          fileKey="src/live.ts:false"
          projectId="p1"
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(
        getGitDiff.mock.calls.filter(([, options]) => options.fullContext),
      ).toHaveLength(2),
    );
    expect(await screen.findByText("full-b")).toBeTruthy();
  });

  it("keeps file identity readable beside compact glyph controls", async () => {
    getGitDiff.mockResolvedValue(result("compact"));
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <GitDiffBody
          file={{
            ...FILE,
            path: "packages/client/src/very-long-file-name.ts",
          }}
          fileKey="packages/client/src/very-long-file-name.ts:false"
          projectId="p1"
          paneHeader={{
            title: "very-long-file-name.ts",
            path: "packages/client/src/very-long-file-name.ts",
          }}
          onToggleIgnoreWhitespace={() => {}}
          t={t}
        />
      </MemoryRouter>,
    );

    await screen.findByText("compact");
    expect(document.querySelector(".git-diff-toolbar-path")?.textContent).toBe(
      "packages/client/src",
    );
    expect(document.querySelector(".git-diff-preview-title")?.textContent).toBe(
      "very-long-file-name.ts",
    );
    expect(
      screen.getByRole("button", { name: "gitStatusIgnoreWhitespace" })
        .textContent,
    ).toBe("␠");
    expect(
      screen.getByRole("button", { name: "gitStatusFullContext" }).textContent,
    ).toBe("");
    expect(
      screen.getByRole("button", {
        name: "diffViewModeTitle: diffViewModeAuto",
      }).textContent,
    ).toBe("");
    await waitFor(() =>
      expect(document.querySelector(".diff-hunk-indicator")?.textContent).toBe(
        "1/1",
      ),
    );
  });
});
