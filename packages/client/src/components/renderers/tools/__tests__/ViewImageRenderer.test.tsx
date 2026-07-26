// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../../i18n";
import { asClientSummarySourceKey } from "../../../../lib/clientSummaryStore";
import type { YaSourceRuntime } from "../../../../lib/sourceRuntime";
import { SourceRuntimeProvider } from "../../../../lib/sourceRuntimeReact";
import { FakeSourceTransport } from "../../../../lib/transport";
import { viewImageRenderer } from "../ViewImageRenderer";

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
    sourceKey: asClientSummarySourceKey("test:view-image-renderer"),
    transport,
    api: {} as YaSourceRuntime["api"],
    summary: {} as YaSourceRuntime["summary"],
    sessionDetails: {} as YaSourceRuntime["sessionDetails"],
  };
}

function renderWithRuntime(children: ReactNode, runtime: YaSourceRuntime) {
  return render(
    <I18nProvider>
      <SourceRuntimeProvider runtime={runtime}>
        {children}
      </SourceRuntimeProvider>
    </I18nProvider>,
  );
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

describe("ViewImageRenderer", () => {
  it("lazily opens viewed images through the shared native-tab modal", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:view-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const fetchBlob = vi.fn(
      async () => new Blob(["png"], { type: "image/png" }),
    );
    const runtime = createRuntime(
      new FakeSourceTransport({
        kind: "secure",
        capabilities: { sameOriginUrls: false },
        fetchBlob,
      }),
    );

    renderWithRuntime(
      <div>
        {viewImageRenderer.renderInteractiveSummary?.(
          { path: "/tmp/plot.png" },
          null,
          false,
          {
            isStreaming: false,
            theme: "dark",
            projectPath: "/tmp",
          },
        )}
      </div>,
      runtime,
    );

    expect(fetchBlob).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /plot\.png/i }));

    await waitFor(() => {
      expect(fetchBlob).toHaveBeenCalledWith(
        "/local-image?path=%2Ftmp%2Fplot.png",
      );
    });
    const imageLink = await screen.findByRole("link", {
      name: "Open image in new tab",
    });
    expect(imageLink.getAttribute("href")).toBe("blob:view-image");
    expect(imageLink.getAttribute("target")).toBe("_blank");
    expect(imageLink.getAttribute("rel")).toBe("noopener noreferrer");
    expect(screen.getByRole("img", { name: "plot.png" })).toBeTruthy();
  });
});
