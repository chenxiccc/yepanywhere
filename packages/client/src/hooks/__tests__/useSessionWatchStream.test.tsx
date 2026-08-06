// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
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
});
