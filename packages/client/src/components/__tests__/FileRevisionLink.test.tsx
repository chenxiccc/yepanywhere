import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileRevisionLink, formatRevisionAge } from "../FileRevisionLink";

const mocks = vi.hoisted(() => ({
  getGitFileRevision: vi.fn(),
  version: { current: "0.7.2" } as { current: string } | null,
}));

vi.mock("../../api/client", () => ({
  api: { getGitFileRevision: mocks.getGitFileRevision },
}));
vi.mock("../../hooks/useRemoteBasePath", () => ({
  useRemoteBasePath: () => "",
}));
vi.mock("../../hooks/useVersion", () => ({
  useRetainedVersionInfo: () => mocks.version,
}));
vi.mock("../../lib/clientSummaryStore", () => ({
  useClientSummarySourceKey: () => "local",
}));
describe("FileRevisionLink", () => {
  beforeEach(() => {
    mocks.version = { current: "0.7.2" };
    mocks.getGitFileRevision.mockReset();
  });

  it("renders a regular blame deep link with age, dirtiness, and tooltip", async () => {
    mocks.getGitFileRevision.mockResolvedValue({
      path: "src/file.ts",
      isGitRepo: true,
      dirty: true,
      commit: {
        hash: "1234567890abcdef",
        shortHash: "1234567",
        authorName: "Ada Lovelace",
        authorDate: "2026-08-23T12:00:00.000Z",
        subject: "Explain revision",
        message: "Explain revision\n\nMore detail",
        messageTruncated: true,
      },
    });

    render(
      <FileRevisionLink
        projectId="project-1"
        path="src/file.ts"
        origPath="src/old.ts"
        dirtyLabel="dirty"
        uncommittedLabel="uncommitted"
      />,
    );

    const link = await screen.findByRole("link", { name: "1234567" });
    expect(link.getAttribute("href")).toBe(
      "/git-status?projectId=project-1&rev=1234567890abcdef&commitFile=src%2Fold.ts&blame=1",
    );
    expect(link.getAttribute("title")).toContain("Ada Lovelace");
    expect(link.getAttribute("title")).toContain("Explain revision");
    expect(link.getAttribute("title")).toMatch(/\n\.\.\.$/);
    expect(screen.getByText("dirty")).not.toBeNull();
    expect(mocks.getGitFileRevision).toHaveBeenCalledWith("project-1", {
      path: "src/file.ts",
      origPath: "src/old.ts",
      rev: undefined,
    });
  });

  it("makes no request when the server lacks the capability", async () => {
    mocks.version = { current: "0.7.1" };
    const { container } = render(
      <FileRevisionLink
        projectId="project-1"
        path="src/file.ts"
        dirtyLabel="dirty"
        uncommittedLabel="uncommitted"
      />,
    );

    await waitFor(() =>
      expect(mocks.getGitFileRevision).not.toHaveBeenCalled(),
    );
    expect(container.childElementCount).toBe(0);
  });

  it("labels a file that has no reachable commit as uncommitted", async () => {
    mocks.getGitFileRevision.mockResolvedValue({
      path: "new.txt",
      isGitRepo: true,
      dirty: false,
      commit: null,
    });
    render(
      <FileRevisionLink
        projectId="project-1"
        path="new.txt"
        dirtyLabel="dirty"
        uncommittedLabel="uncommitted"
      />,
    );

    expect(await screen.findByText("uncommitted")).not.toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });
});

describe("formatRevisionAge", () => {
  const now = Date.parse("2026-08-25T12:00:00.000Z");

  it("uses compact elapsed units", () => {
    expect(formatRevisionAge("2026-08-25T11:58:00.000Z", now)).toBe("2m ago");
    expect(formatRevisionAge("2026-08-23T12:00:00.000Z", now)).toBe("2d ago");
  });
});
