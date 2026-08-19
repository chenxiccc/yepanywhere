import {
  act,
  cleanup,
  render,
  renderHook,
  screen,
} from "@testing-library/react";
import type {
  GitFileProjectionManifest,
  GitStatusInfo,
  GitWorkingTreeFile,
} from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileVersionControlLinks } from "../../components/FileDiffViewLinks";
import { I18nProvider } from "../../i18n";
import { resetClientQueryControllerForTests } from "../../lib/clientQueryController";
import {
  asClientSummarySourceKey,
  resetClientSummaryStoreForTests,
} from "../../lib/clientSummaryStore";
import { resetRouteRetentionForTests } from "../../lib/routeRetention";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../lib/transport";
import { useFileVersionControl } from "../useFileVersionControl";
import { resetVersionSnapshotsForTests, useVersion } from "../useVersion";

const mocks = vi.hoisted(() => ({
  getGitFileProjections: vi.fn(),
  getGitStatus: vi.fn(),
  getVersion: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  api: {
    getGitFileProjections: mocks.getGitFileProjections,
    getGitStatus: mocks.getGitStatus,
    getVersion: mocks.getVersion,
  },
}));
vi.mock("../../lib/connection", () => ({
  isRemoteClient: () => false,
}));
vi.mock("../../contexts/RemoteConnectionContext", () => ({
  useOptionalRemoteConnection: () => null,
}));

const STATUS: GitStatusInfo = {
  isGitRepo: true,
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  isClean: false,
  files: [
    {
      path: "src/worktree.ts",
      status: "M",
      staged: false,
      linesAdded: 1,
      linesDeleted: 0,
    },
  ],
  recentCommits: [
    {
      hash: "head-sha",
      shortHash: "head",
      subject: "head",
      authorName: "Test",
      authorDate: "2026-08-10T00:00:00.000Z",
    },
  ],
  checkedRemoteAt: null,
};

const MANIFEST: GitFileProjectionManifest = {
  headSha: "head-sha",
  baseSha: "parent-sha",
  worktreeFiles: [STATUS.files[0]!],
  cumulativeFiles: [
    {
      path: "src/committed.ts",
      status: "M",
      staged: false,
      linesAdded: 2,
      linesDeleted: 1,
    },
  ],
};

function useSubject(path: string) {
  useVersion();
  return useFileVersionControl("project-a", path);
}

function VersionLinksFixture({ count }: { count: number }) {
  useVersion();
  return (
    <I18nProvider>
      {Array.from({ length: count }, (_, index) => (
        <FileVersionControlLinks
          key={index}
          filePath="src/worktree.ts"
          projectId="project-a"
        />
      ))}
    </I18nProvider>
  );
}

function createRuntime(transport: FakeSourceTransport): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey("test:file-version-control"),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

function createWrapper(runtime: YaSourceRuntime) {
  return function TestSourceRuntimeProvider({
    children,
  }: {
    children: ReactNode;
  }) {
    return (
      <SourceRuntimeProvider runtime={runtime}>
        {children}
      </SourceRuntimeProvider>
    );
  };
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  resetRouteRetentionForTests();
  resetVersionSnapshotsForTests();
  mocks.getVersion.mockReset();
  mocks.getGitStatus.mockReset();
  mocks.getGitFileProjections.mockReset();
  mocks.getVersion.mockResolvedValue({
    current: "0.7.1",
    latest: null,
    updateAvailable: false,
  });
  mocks.getGitStatus.mockResolvedValue(STATUS);
  mocks.getGitFileProjections.mockResolvedValue(MANIFEST);
});

afterEach(() => {
  cleanup();
  resetVersionSnapshotsForTests();
  resetClientQueryControllerForTests();
  resetClientSummaryStoreForTests();
  resetRouteRetentionForTests();
  vi.useRealTimers();
});

describe("useFileVersionControl", () => {
  it("uses one live worktree subscription without status or manifest requests", async () => {
    mocks.getVersion.mockResolvedValue({
      current: "0.7.2",
      latest: null,
      updateAvailable: false,
    });
    const transport = new FakeSourceTransport();
    const hook = renderHook(
      () => [useSubject("src/worktree.ts"), useSubject("src/other.ts")],
      { wrapper: createWrapper(createRuntime(transport)) },
    );
    await settle();

    const subscriptions = transport.getSubscriptions("worktree");
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0]).toMatchObject({
      projectId: "project-a",
      coverage: { tracked: true, untracked: true, ignored: false },
    });
    const worktreeRow: GitWorkingTreeFile = {
      path: "src/worktree.ts",
      tracked: true,
      kind: "tracked",
      worktreeChanges: [STATUS.files[0]!],
      cumulativeChange: {
        status: "M",
        staged: false,
        linesAdded: 3,
        linesDeleted: 1,
      },
    };
    const files: GitWorkingTreeFile[] = [
      worktreeRow,
      { path: "src/other.ts", tracked: true, kind: "tracked" },
      ...Array.from({ length: 10_000 }, (_, index) => ({
        path: `scratch/generated-${index}.txt`,
        tracked: false,
        kind: "untracked" as const,
      })),
    ];
    const subscription = subscriptions[0];
    if (!subscription) throw new Error("Expected worktree subscription");
    act(() => {
      transport.emitSubscriptionEvent(
        subscription.id,
        "git-worktree-snapshot",
        {
          type: "git-worktree-snapshot",
          generation: { epoch: "epoch-a", sequence: 0 },
          coverage: subscription.coverage,
          headSha: "head-sha",
          baseSha: "parent-sha",
          files,
          truncated: false,
          timestamp: "2026-08-19T00:00:00.000Z",
        },
      );
    });

    expect(hook.result.current[0]).toMatchObject({
      supported: true,
      loading: false,
      relativePath: "src/worktree.ts",
      worktreeFile: { path: "src/worktree.ts", linesAdded: 1 },
      cumulativeFile: { path: "src/worktree.ts", linesAdded: 3 },
    });
    expect(hook.result.current[1]).toMatchObject({
      supported: true,
      loading: false,
      relativePath: "src/other.ts",
      worktreeFile: null,
      cumulativeFile: null,
    });
    expect(mocks.getGitStatus).not.toHaveBeenCalled();
    expect(mocks.getGitFileProjections).not.toHaveBeenCalled();
  });

  it("exposes only the exact projections containing the path", async () => {
    const worktree = renderHook(() => useSubject("src/worktree.ts"));
    const cumulative = renderHook(() => useSubject("src/committed.ts"));

    expect(worktree.result.current.loading).toBe(true);
    expect(cumulative.result.current.loading).toBe(true);

    await settle();

    expect(worktree.result.current).toMatchObject({
      supported: true,
      loading: false,
      relativePath: "src/worktree.ts",
      worktreeFile: { path: "src/worktree.ts" },
      cumulativeFile: null,
    });
    expect(cumulative.result.current).toMatchObject({
      supported: true,
      loading: false,
      relativePath: "src/committed.ts",
      worktreeFile: null,
      cumulativeFile: { path: "src/committed.ts" },
    });
    expect(mocks.getGitFileProjections).toHaveBeenCalledTimes(1);
  });

  it("settles without selectors when the optional manifest fails", async () => {
    mocks.getGitFileProjections.mockRejectedValue(new Error("unavailable"));
    const hook = renderHook(() => useSubject("src/worktree.ts"));
    await settle();

    expect(hook.result.current).toMatchObject({
      supported: true,
      loading: false,
      worktreeFile: null,
      cumulativeFile: null,
    });
  });

  it("mounts shared version links without publishing expired snapshots during render", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    const rendered = render(<VersionLinksFixture count={3} />);
    await settle();
    expect(screen.getAllByText("vs HEAD")).toHaveLength(3);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_001);
    });
    rendered.rerender(<VersionLinksFixture count={6} />);
    await settle();

    expect(screen.getAllByText("vs HEAD")).toHaveLength(6);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
