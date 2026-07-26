// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

  it("finds a tracked file beyond the old 500-row rendering limit", async () => {
    const files = Array.from(
      { length: 650 },
      (_, index) => `src/file-${index.toString().padStart(3, "0")}.ts`,
    );
    const tail = "src/file-649.ts";
    listGitFiles.mockResolvedValue({ files, truncated: false });
    getGitBlame.mockResolvedValue({
      path: files[0],
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
        <BlameBrowser projectId="p1" isWideScreen={false} t={t} />
      </MemoryRouter>,
    );

    await screen.findByText(files[0] as string);
    fireEvent.change(screen.getByPlaceholderText("sourceFilterFiles"), {
      target: { value: "file-649" },
    });

    expect(await screen.findByText(tail)).toBeTruthy();
    expect(screen.queryByText("sourceFilesTruncated")).toBeNull();
  });
});
