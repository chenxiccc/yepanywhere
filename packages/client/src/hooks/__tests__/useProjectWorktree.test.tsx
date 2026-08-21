import { act, cleanup, renderHook } from "@testing-library/react";
import type {
  GitWorkingTreeFile,
  GitWorktreeCoverage,
} from "@yep-anywhere/shared";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../lib/transport";
import { useProjectWorktree } from "../useProjectWorktree";

const COVERAGE: GitWorktreeCoverage = {
  tracked: true,
  untracked: true,
  ignored: false,
};

function createWrapper(transport: FakeSourceTransport) {
  const runtime: YaSourceRuntime = {
    sourceKey: asClientSummarySourceKey("test:worktree-deferral"),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <SourceRuntimeProvider runtime={runtime}>
        {children}
      </SourceRuntimeProvider>
    );
  };
}

function latestSubscription(transport: FakeSourceTransport) {
  const subscription = transport.getSubscriptions("worktree").at(-1);
  if (!subscription) throw new Error("Expected worktree subscription");
  return subscription;
}

function file(path: string): GitWorkingTreeFile {
  return { path, tracked: true, kind: "tracked" };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useProjectWorktree", () => {
  it("releases its lease while paused and reacquires it on resume", async () => {
    const transport = new FakeSourceTransport();
    const rendered = renderHook(
      ({ paused }: { paused: boolean }) =>
        useProjectWorktree("project-a", COVERAGE, true, paused),
      {
        initialProps: { paused: false },
        wrapper: createWrapper(transport),
      },
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(transport.getSubscriptions("worktree")).toHaveLength(1);
    expect(transport.getSubscriptions("worktree")[0]?.closed).toBe(false);

    rendered.rerender({ paused: true });
    expect(transport.getSubscriptions("worktree")[0]?.closed).toBe(true);

    rendered.rerender({ paused: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport.getSubscriptions("worktree")).toHaveLength(2);
    expect(transport.getSubscriptions("worktree")[1]?.closed).toBe(false);
  });

  it("does not reconnect for equal expanded-prefix arrays", async () => {
    const transport = new FakeSourceTransport();
    const rendered = renderHook(
      ({ coverage }: { coverage: GitWorktreeCoverage }) =>
        useProjectWorktree("project-a", coverage, true),
      {
        initialProps: {
          coverage: {
            ...COVERAGE,
            expandedPrefixes: [],
          } as GitWorktreeCoverage,
        },
        wrapper: createWrapper(transport),
      },
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(latestSubscription(transport).coverage).toEqual({
      ...COVERAGE,
      expandedPrefixes: [],
    });

    rendered.rerender({
      coverage: { ...COVERAGE, expandedPrefixes: [] },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);

    rendered.rerender({
      coverage: { ...COVERAGE, expandedPrefixes: ["src"] },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport.getSubscriptions("worktree")).toHaveLength(2);
    expect(latestSubscription(transport).coverage).toEqual({
      ...COVERAGE,
      expandedPrefixes: ["src"],
    });

    rendered.rerender({
      coverage: {
        ...COVERAGE,
        expandedPrefixes: ["src"],
        filesystemScan: "complete",
      },
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(transport.getSubscriptions("worktree")).toHaveLength(3);
    expect(latestSubscription(transport).coverage).toEqual({
      ...COVERAGE,
      expandedPrefixes: ["src"],
      filesystemScan: "complete",
    });
  });

  it("pins the deferred-update deadline to the first unapplied delta", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const transport = new FakeSourceTransport();
    const rendered = renderHook(
      () => useProjectWorktree("project-a", COVERAGE, true, false, true),
      { wrapper: createWrapper(transport) },
    );
    await act(async () => {
      await Promise.resolve();
    });
    const subscription = latestSubscription(transport);

    act(() => {
      transport.emitSubscriptionEvent(
        subscription.id,
        "git-worktree-snapshot",
        {
          type: "git-worktree-snapshot",
          generation: { epoch: "epoch-a", sequence: 0 },
          coverage: COVERAGE,
          headSha: "head-a",
          baseSha: "base-a",
          files: [file("README.md")],
          truncated: false,
          timestamp: "2026-08-19T00:00:00.000Z",
        },
      );
    });
    expect(rendered.result.current.files.map(({ path }) => path)).toEqual([
      "README.md",
    ]);

    act(() => {
      transport.emitSubscriptionEvent(subscription.id, "git-worktree-delta", {
        type: "git-worktree-delta",
        generation: { epoch: "epoch-a", sequence: 1 },
        headSha: "head-a",
        baseSha: "base-a",
        changes: [
          {
            changeType: "create",
            path: "first.ts",
            file: file("first.ts"),
          },
        ],
        timestamp: "2026-08-19T00:00:01.000Z",
      });
    });
    expect(rendered.result.current.files).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_000);
    });
    act(() => {
      transport.emitSubscriptionEvent(subscription.id, "git-worktree-delta", {
        type: "git-worktree-delta",
        generation: { epoch: "epoch-a", sequence: 2 },
        headSha: "head-a",
        baseSha: "base-a",
        changes: [
          {
            changeType: "create",
            path: "second.ts",
            file: file("second.ts"),
          },
        ],
        timestamp: "2026-08-19T00:00:04.000Z",
      });
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(rendered.result.current.files).toHaveLength(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(rendered.result.current.files.map(({ path }) => path)).toEqual([
      "README.md",
      "first.ts",
      "second.ts",
    ]);
    expect(transport.getSubscriptions("worktree")).toHaveLength(1);
  });
});
