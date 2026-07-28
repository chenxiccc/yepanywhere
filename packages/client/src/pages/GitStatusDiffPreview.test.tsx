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

    fireEvent.click(screen.getByText("gitStatusFullContext"));
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
});
