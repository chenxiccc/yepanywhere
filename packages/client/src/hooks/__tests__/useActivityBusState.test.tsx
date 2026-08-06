// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../lib/transport";
import { useActivityBusState } from "../useActivityBusState";

function createRuntime(transport: FakeSourceTransport): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey("test:activity-state"),
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

afterEach(() => {
  cleanup();
});

describe("useActivityBusState", () => {
  it("maps current source transport status to legacy connection states", () => {
    const transport = new FakeSourceTransport();
    const { result } = renderHook(() => useActivityBusState(), {
      wrapper: createWrapper(createRuntime(transport)),
    });

    expect(result.current).toMatchObject({
      connected: true,
      connectionState: "connected",
      transportState: "ready",
    });

    act(() => {
      transport.setState("reconnecting");
    });
    expect(result.current).toMatchObject({
      connected: false,
      connectionState: "reconnecting",
      transportState: "reconnecting",
    });

    act(() => {
      transport.setState("disconnected");
    });
    expect(result.current).toMatchObject({
      connected: false,
      connectionState: "disconnected",
      transportState: "disconnected",
    });
  });
});
