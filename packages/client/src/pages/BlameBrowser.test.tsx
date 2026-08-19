// @vitest-environment jsdom

import type { GitStatusInfo } from "@yep-anywhere/shared";
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
vi.mock("../i18n", async (orig) => ({
  ...(await orig<typeof import("../i18n")>()),
  useI18n: () => ({ t: (key: string) => key }),
}));

const listGitFiles = vi.fn();
const listGitWorkingTreeFiles = vi.fn();
const getGitBlame = vi.fn();
const getFile = vi.fn();
const listReviewComments = vi.fn();
vi.mock("../api/client", () => ({
  api: {
    listGitFiles: (...args: unknown[]) => listGitFiles(...args),
    listGitWorkingTreeFiles: (...args: unknown[]) =>
      listGitWorkingTreeFiles(...args),
    getFile: (...args: unknown[]) => getFile(...args),
    getFileRawUrl: () => "/raw/file",
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
    getFile.mockResolvedValue({
      metadata: {
        path: "src/first.ts",
        size: 0,
        mimeType: "text/plain",
        isText: true,
      },
      content: "",
      rawUrl: "/raw/src/first.ts",
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

    const row = document.querySelector<HTMLButtonElement>(
      ".blame-file-item.selected",
    )!;
    fireEvent.contextMenu(row, { clientX: 32, clientY: 40 });
    expect(await screen.findByRole("menu")).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "sourceOpenFile" }),
    ).toBeDefined();
    expect(
      screen.getByRole("menuitem", { name: "sourceCopyPath" }),
    ).toBeDefined();
    expect(
      screen.getAllByRole("separator", {
        name: "sourceResizeFilePane",
      }),
    ).toHaveLength(2);
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
    getFile.mockResolvedValue({
      metadata: {
        path: files[0],
        size: 0,
        mimeType: "text/plain",
        isText: true,
      },
      content: "",
      rawUrl: `/raw/${files[0]}`,
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

    await waitFor(() =>
      expect(
        document.querySelector(`[data-source-path="${tail}"]`),
      ).not.toBeNull(),
    );
    expect(screen.queryByText("sourceFilesTruncated")).toBeNull();
  });

  it("browses current dirty and unchanged content behind the new capability", async () => {
    const groupedCleanFiles = Array.from(
      { length: 12 },
      (_, index) =>
        `packages/client/file-${index.toString().padStart(3, "0")}.ts`,
    );
    listGitWorkingTreeFiles.mockResolvedValue({
      files: [
        { path: "README.md", tracked: true },
        { path: "notes/new.txt", tracked: false },
        ...groupedCleanFiles.map((path) => ({ path, tracked: true })),
        { path: "src/live.ts", tracked: true },
      ],
      truncated: false,
      limit: 50_000,
    });
    getFile.mockImplementation((_projectId: string, path: string) =>
      Promise.resolve({
        metadata: {
          path,
          size: path.length,
          mimeType: "text/plain",
          isText: true,
        },
        content: `contents:${path}`,
        rawUrl: `/raw/${path}`,
      }),
    );
    getGitBlame.mockResolvedValue({
      path: "README.md",
      rev: "HEAD",
      lines: [],
      truncated: false,
    });
    listReviewComments.mockResolvedValue({
      comments: [],
      batches: [],
      pendingCount: 0,
    });
    const status: GitStatusInfo = {
      isGitRepo: true,
      branch: "main",
      upstream: "origin/main",
      ahead: 0,
      behind: 0,
      isClean: false,
      files: [
        {
          path: "src/live.ts",
          status: "M",
          staged: false,
          linesAdded: 1,
          linesDeleted: 0,
        },
      ],
    };

    render(
      <MemoryRouter>
        <BlameBrowser
          projectId="p1"
          isWideScreen={true}
          status={status}
          supportsWorkingTreeFiles
          t={t}
        />
      </MemoryRouter>,
    );

    await waitFor(() =>
      expect(listGitWorkingTreeFiles).toHaveBeenCalledWith("p1"),
    );
    expect(listGitFiles).not.toHaveBeenCalled();
    expect(screen.getByText("sourceUnchangedFiles")).toBeDefined();
    await waitFor(() =>
      expect(
        document.querySelector(
          '[data-source-path="packages/client/file-000.ts"]',
        ),
      ).not.toBeNull(),
    );

    fireEvent.click(screen.getByText("packages/client/").closest("button")!);
    expect(
      document.querySelector(
        '[data-source-path="packages/client/file-000.ts"]',
      ),
    ).toBeNull();
    fireEvent.click(screen.getByText("packages/client/").closest("button")!);

    fireEvent.click(screen.getByText("README.md"));
    await waitFor(() =>
      expect(
        getFile.mock.calls.some(
          ([projectId, path]) => projectId === "p1" && path === "README.md",
        ),
      ).toBe(true),
    );
    expect(await screen.findByText("contents:README.md")).toBeDefined();
    expect(getGitBlame).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "sourceViewBlame" }));
    await waitFor(() =>
      expect(getGitBlame).toHaveBeenCalledWith("p1", "README.md"),
    );
  });
});
