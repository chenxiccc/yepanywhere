// @vitest-environment jsdom

import type {
  DeviceServerMessage,
  RemoteClientMessage,
} from "@yep-anywhere/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../lib/transport";
import { useEmulatorStream } from "../useEmulatorStream";

class MockRTCPeerConnection {
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  iceGatheringState: RTCIceGatheringState = "new";
  signalingState: RTCSignalingState = "stable";
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((event: RTCDataChannelEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onicegatheringstatechange: (() => void) | null = null;
  onsignalingstatechange: (() => void) | null = null;
  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  close = vi.fn();
  setRemoteDescription = vi.fn(async () => {});
  setLocalDescription = vi.fn(async () => {});
  createAnswer = vi.fn(async () => ({
    type: "answer" as RTCSdpType,
    sdp: "answer-sdp",
  }));
}

function createRuntime(transport: FakeSourceTransport): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey("test:emulator-stream"),
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
  vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useEmulatorStream", () => {
  it("starts device streaming through the source transport device capability", async () => {
    let handler: ((msg: DeviceServerMessage) => void) | null = null;
    const send = vi.fn(async (_msg: RemoteClientMessage) => {});
    const transport = new FakeSourceTransport({
      capabilities: {
        sameOriginUrls: true,
        device: {
          send,
          onMessage: (nextHandler) => {
            handler = nextHandler;
            return () => {
              handler = null;
            };
          },
        },
      },
    });

    const { result } = renderHook(() => useEmulatorStream(), {
      wrapper: createWrapper(createRuntime(transport)),
    });

    act(() => {
      result.current.connect({ id: "emulator-5554", type: "emulator" });
    });

    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "device_stream_start",
          deviceId: "emulator-5554",
          deviceType: "emulator",
        }),
      );
    });
    expect(handler).not.toBeNull();
  });

  it("reports unsupported device streaming when the source has no device capability", () => {
    const transport = new FakeSourceTransport({
      capabilities: { sameOriginUrls: true },
    });
    const { result } = renderHook(() => useEmulatorStream(), {
      wrapper: createWrapper(createRuntime(transport)),
    });

    act(() => {
      result.current.connect({ id: "emulator-5554", type: "emulator" });
    });

    expect(result.current.connectionState).toBe("failed");
    expect(result.current.error).toBe(
      "Device streaming is not available for this source",
    );
  });

  it("stops an active stream through its original channel when the source changes", async () => {
    const unsubscribeA = vi.fn();
    const sendA = vi.fn(async (_msg: RemoteClientMessage) => {});
    const sendB = vi.fn(async (_msg: RemoteClientMessage) => {});
    const transportA = new FakeSourceTransport({
      capabilities: {
        sameOriginUrls: true,
        device: {
          send: sendA,
          onMessage: () => unsubscribeA,
        },
      },
    });
    const transportB = new FakeSourceTransport({
      capabilities: {
        sameOriginUrls: true,
        device: {
          send: sendB,
          onMessage: () => vi.fn(),
        },
      },
    });
    let runtime = createRuntime(transportA);
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <SourceRuntimeProvider runtime={runtime}>
        {children}
      </SourceRuntimeProvider>
    );
    const hook = renderHook(() => useEmulatorStream(), { wrapper: Wrapper });

    act(() => {
      hook.result.current.connect({ id: "emulator-5554", type: "emulator" });
    });
    await waitFor(() => {
      expect(sendA).toHaveBeenCalledWith(
        expect.objectContaining({ type: "device_stream_start" }),
      );
    });

    runtime = createRuntime(transportB);
    hook.rerender();

    await waitFor(() => {
      expect(sendA).toHaveBeenCalledWith(
        expect.objectContaining({ type: "device_stream_stop" }),
      );
    });
    expect(sendB).not.toHaveBeenCalled();
    expect(unsubscribeA).toHaveBeenCalledOnce();
    expect(hook.result.current.connectionState).toBe("idle");
  });
});
