// @vitest-environment jsdom

import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { asClientSummarySourceKey } from "../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../lib/transport";
import { useFetchedImage, useRemoteImage } from "../useRemoteImage";

const originalCreateObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "createObjectURL",
);
const originalRevokeObjectUrlDescriptor = Object.getOwnPropertyDescriptor(
  URL,
  "revokeObjectURL",
);

function restoreObjectProperty(
  target: object,
  name: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
) {
  if (descriptor) {
    Object.defineProperty(target, name, descriptor);
  } else {
    Reflect.deleteProperty(target, name);
  }
}

function createRuntime(transport: FakeSourceTransport): YaSourceRuntime {
  return {
    sourceKey: asClientSummarySourceKey("test:remote-image"),
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
  vi.unstubAllGlobals();
  restoreObjectProperty(
    URL,
    "createObjectURL",
    originalCreateObjectUrlDescriptor,
  );
  restoreObjectProperty(
    URL,
    "revokeObjectURL",
    originalRevokeObjectUrlDescriptor,
  );
});

describe("useRemoteImage", () => {
  it("returns same-origin API paths directly", () => {
    const fetchBlob = vi.fn();
    const transport = new FakeSourceTransport({
      capabilities: { sameOriginUrls: true },
      fetchBlob,
    });

    const { result } = renderHook(
      () => useRemoteImage("/api/projects/p/upload/image.png"),
      { wrapper: createWrapper(createRuntime(transport)) },
    );

    expect(result.current).toMatchObject({
      url: "/api/projects/p/upload/image.png",
      loading: false,
      error: null,
    });
    expect(fetchBlob).not.toHaveBeenCalled();
  });

  it("fetches through the source transport when same-origin URLs are unavailable", async () => {
    const fetchBlob = vi.fn(
      async () => new Blob(["png"], { type: "image/png" }),
    );
    const transport = new FakeSourceTransport({
      kind: "secure",
      capabilities: { sameOriginUrls: false },
      fetchBlob,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:remote-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    const { result } = renderHook(
      () => useRemoteImage("/api/projects/p/upload/image.png"),
      { wrapper: createWrapper(createRuntime(transport)) },
    );

    await waitFor(() => {
      expect(result.current.url).toBe("blob:remote-image");
    });
    expect(fetchBlob).toHaveBeenCalledWith("/projects/p/upload/image.png");
  });

  it("always fetches useFetchedImage through the source transport", async () => {
    const fetchBlob = vi.fn(
      async () => new Blob(["png"], { type: "image/png" }),
    );
    const transport = new FakeSourceTransport({
      capabilities: { sameOriginUrls: true },
      fetchBlob,
    });
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:fetched-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });

    const { result } = renderHook(
      () => useFetchedImage("/api/local-image?path=%2Ftmp%2Fplot.png"),
      { wrapper: createWrapper(createRuntime(transport)) },
    );

    await waitFor(() => {
      expect(result.current.url).toBe("blob:fetched-image");
      expect(result.current.blob).toBeInstanceOf(Blob);
    });
    expect(fetchBlob).toHaveBeenCalledWith(
      "/local-image?path=%2Ftmp%2Fplot.png",
    );
  });
});
