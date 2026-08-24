// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../lib/transport";
import { useSessionWatchStream } from "../useSessionWatchStream";

function createRuntime(
  transport: FakeSourceTransport,
  sourceKey = "test:source",
): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey(sourceKey),
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

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("useSessionWatchStream", () => {
  it("passes optional change facts to the subscriber", () => {
    const transport = new FakeSourceTransport();
    const wrapper = createWrapper(createRuntime(transport));
    const onChange = vi.fn();

    renderHook(
      () =>
        useSessionWatchStream(
          {
            projectId: "project-1",
            provider: "claude",
            sessionId: "session-1",
          },
          { onChange },
        ),
      { wrapper },
    );

    const subscription = transport.getSubscriptions("session-watch")[0];
    expect(subscription).toBeDefined();
    act(() => {
      transport.emitSubscriptionEvent(
        subscription!.id,
        "session-watch-change",
        {
          type: "session-watch-change",
          sessionId: "session-1",
          projectId: "project-1",
          provider: "claude",
          path: "/tmp/session-1.jsonl",
          source: "fs-watch",
          changeVersion: 7,
          sourceObservedAt: "2026-08-08T17:00:00.000Z",
          mtimeMs: 1234.5,
          size: 456,
          timestamp: "2026-08-08T17:00:00.010Z",
        },
      );
    });

    expect(onChange).toHaveBeenCalledWith({
      type: "session-watch-change",
      sessionId: "session-1",
      projectId: "project-1",
      provider: "claude",
      path: "/tmp/session-1.jsonl",
      source: "fs-watch",
      changeVersion: 7,
      sourceObservedAt: "2026-08-08T17:00:00.000Z",
      mtimeMs: 1234.5,
      size: 456,
      timestamp: "2026-08-08T17:00:00.010Z",
    });
  });

  it("does not resubscribe for a new target object with the same values", () => {
    const transport = new FakeSourceTransport();
    const wrapper = createWrapper(createRuntime(transport));

    const { rerender, unmount } = renderHook(
      ({ target }) =>
        useSessionWatchStream(target, {
          onChange: vi.fn(),
        }),
      {
        initialProps: {
          target: {
            projectId: "project-1",
            provider: "claude",
            sessionId: "session-1",
          },
        },
        wrapper,
      },
    );

    expect(transport.getSubscriptions("session-watch")).toHaveLength(1);
    const first = transport.getSubscriptions("session-watch")[0];
    expect(first).toMatchObject({
      sessionId: "session-1",
      options: { projectId: "project-1", provider: "claude" },
      closed: false,
    });

    rerender({
      target: {
        projectId: "project-1",
        provider: "claude",
        sessionId: "session-1",
      },
    });

    expect(transport.getSubscriptions("session-watch")).toHaveLength(1);
    expect(transport.getSubscriptions("session-watch")[0]).toMatchObject({
      id: first?.id,
      closed: false,
      closeCalls: 0,
    });

    rerender({
      target: {
        projectId: "project-1",
        provider: "codex",
        sessionId: "session-1",
      },
    });

    expect(transport.getSubscriptions("session-watch")).toHaveLength(2);
    expect(transport.getSubscriptions("session-watch")[0]).toMatchObject({
      id: first?.id,
      closed: true,
      closeCalls: 1,
    });
    expect(transport.getSubscriptions("session-watch")[1]).toMatchObject({
      sessionId: "session-1",
      options: { projectId: "project-1", provider: "codex" },
      closed: false,
    });

    unmount();

    expect(transport.getSubscriptions("session-watch")[1]).toMatchObject({
      closed: true,
      closeCalls: 1,
    });
  });

  it("requests catch-up after a watch subscription reconnects", () => {
    const transport = new FakeSourceTransport();
    const wrapper = createWrapper(createRuntime(transport));
    const onReconnect = vi.fn();

    renderHook(
      () =>
        useSessionWatchStream(
          {
            projectId: "project-1",
            provider: "claude",
            sessionId: "session-1",
          },
          { onChange: vi.fn(), onReconnect },
        ),
      { wrapper },
    );

    const first = transport.getSubscriptions("session-watch")[0];
    act(() => {
      transport.openSubscription(first!.id);
    });
    expect(onReconnect).not.toHaveBeenCalled();

    act(() => {
      transport.setState("reconnecting");
      transport.setState("ready");
    });
    const second = transport.getSubscriptions("session-watch")[1];
    act(() => {
      transport.openSubscription(second!.id);
    });

    expect(onReconnect).toHaveBeenCalledTimes(1);
  });
});
