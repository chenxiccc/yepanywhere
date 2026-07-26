// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("react-router-dom", async (orig) => ({
  ...(await orig<typeof import("react-router-dom")>()),
  useNavigate: () => vi.fn(),
}));
vi.mock("../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));

const listGitFiles = vi.fn();
const getGitBlame = vi.fn();
const listReviewComments = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    listGitFiles: (...args: unknown[]) => listGitFiles(...args),
    getGitBlame: (...args: unknown[]) => getGitBlame(...args),
    listReviewComments: (...args: unknown[]) => listReviewComments(...args),
  },
}));

import { BlameBrowser } from "./BlameBrowser";

const t = (key: string) => key;

describe("BlameBrowser", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("opens the first visible file in the wide master-detail view", async () => {
    listGitFiles.mockResolvedValue({
      files: ["src/first.ts", "src/second.ts"],
      truncated: false,
    });
    getGitBlame.mockResolvedValue({
      path: "src/first.ts",
      rev: "HEAD",
      lines: [],
      truncated: false,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });

    render(
      <MemoryRouter>
        <BlameBrowser projectId="p1" isWideScreen={true} t={t} />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(getGitBlame).toHaveBeenCalledWith("p1", "src/first.ts"),
    );
    expect(
      document
        .querySelector(".blame-file-item.selected")
        ?.textContent?.includes("src/first.ts"),
    ).toBe(true);
  });
});
