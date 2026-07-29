import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { toUrlProjectId } from "@yep-anywhere/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionMetadataProvider } from "../../contexts/SessionMetadataContext";
import { I18nProvider } from "../../i18n";
import { LocalFileModal, LocalMediaModal } from "../LocalMediaModal";

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

describe("LocalFileModal", () => {
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

  it("shows project-relative metadata while fetching the raw local path", async () => {
    const projectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const rawPath = `${projectRoot}\\docs\\note.md`;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) => {
        return new Response("hello", {
          headers: { "Content-Type": "text/plain" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      <I18nProvider>
        <SessionMetadataProvider
          projectId={toUrlProjectId(projectRoot)}
          projectPath={projectRoot}
          sessionId="session-1"
        >
          <LocalFileModal
            resource={{
              kind: "local-file",
              path: rawPath,
              lineNumber: 12,
              columnNumber: 4,
            }}
            onClose={() => {}}
          />
        </SessionMetadataProvider>
      </I18nProvider>,
    );

    const metadata = screen.getByText("docs/note.md:12:4");
    expect(metadata.getAttribute("title")).toBe(`${rawPath}:12:4`);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
      encodeURIComponent(rawPath),
    );
  });
});

describe("LocalMediaModal", () => {
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

  it("opens one fullscreen viewer with explicit zoom and download", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:local-media-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const fetchBlob = vi.fn(
      async () => new Blob(["png"], { type: "image/png" }),
    );
    render(
      <I18nProvider>
        <LocalMediaModal
          path="/tmp/plot.png"
          mediaType="image"
          mediaSource={{ fetchBlob }}
          onClose={() => {}}
        />
      </I18nProvider>,
    );

    const imageLink = await screen.findByRole("link", { name: "plot.png" });
    expect(imageLink.getAttribute("href")).toBe("blob:local-media-image");
    expect(imageLink.getAttribute("target")).toBe("_blank");
    expect(imageLink.getAttribute("rel")).toBe("noopener noreferrer");

    const downloadLink = screen.getByRole("link", {
      name: "Download plot.png",
    });
    expect(downloadLink.getAttribute("href")).toBe("blob:local-media-image");
    expect(downloadLink.getAttribute("download")).toBe("plot.png");

    expect(
      screen.getByRole("dialog").querySelector(".local-media-image-viewer"),
    ).toBeTruthy();
    const imageSurface = screen.getByRole("button", {
      name: "Close viewer and return from plot.png",
    });
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    expect(
      screen
        .getByRole("button", {
          name: "Close viewer and return from plot.png",
        })
        .classList.contains("is-zoom"),
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Fit" }));
    expect(imageSurface.classList.contains("is-fit")).toBe(true);

    const image = screen.getByRole("img", { name: "plot.png" });
    Object.defineProperties(image, {
      naturalHeight: { configurable: true, value: 1080 },
      naturalWidth: { configurable: true, value: 1920 },
    });
    fireEvent.load(image);
    const stage = screen
      .getByRole("dialog")
      .querySelector<HTMLElement>(".local-media-image-stage");
    expect(stage).toBeTruthy();
    if (!stage) return;
    Object.defineProperties(stage, {
      clientHeight: { configurable: true, value: 700 },
      clientWidth: { configurable: true, value: 1000 },
      setPointerCapture: { configurable: true, value: vi.fn() },
    });
    stage.getBoundingClientRect = vi.fn(() => ({
      bottom: 700,
      height: 700,
      left: 0,
      right: 1000,
      toJSON: () => ({}),
      top: 0,
      width: 1000,
      x: 0,
      y: 0,
    }));
    const dispatchTouchPointer = (
      type: "pointerdown" | "pointermove",
      pointerId: number,
      clientX: number,
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        clientX,
        clientY: 300,
      });
      Object.defineProperties(event, {
        pointerId: { value: pointerId },
        pointerType: { value: "touch" },
      });
      fireEvent(stage, event);
    };
    dispatchTouchPointer("pointerdown", 1, 300);
    dispatchTouchPointer("pointerdown", 2, 500);
    dispatchTouchPointer("pointermove", 2, 700);
    expect(
      screen
        .getByRole("button", {
          name: "Close viewer and return from plot.png",
        })
        .classList.contains("is-zoom"),
    ).toBe(true);
    expect(
      stage.parentElement?.querySelector(".local-media-image-zoom")
        ?.textContent,
    ).toBe("101%");

    expect(fetchBlob).toHaveBeenCalledWith(
      "/tmp/plot.png",
      "/api/local-image?path=%2Ftmp%2Fplot.png",
      "modal",
    );
  });

  it("dismisses the image viewer from its stage, image, controls, and keyboard", async () => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:local-media-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    const onClose = vi.fn();

    render(
      <I18nProvider>
        <LocalMediaModal
          path="/tmp/plot.png"
          mediaType="image"
          mediaSource={{
            fetchBlob: async () =>
              new Blob(["png"], { type: "image/png" }),
          }}
          onClose={onClose}
        />
      </I18nProvider>,
    );

    const stageControl = await screen.findByRole("button", {
      name: "Close viewer and return from plot.png",
    });
    const stage = screen
      .getByRole("dialog")
      .querySelector<HTMLElement>(".local-media-image-stage");
    expect(stage).toBeTruthy();
    if (!stage) return;
    expect(stage).toBe(stageControl);

    fireEvent.click(stage);
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("img", { name: "plot.png" }));
    expect(onClose).toHaveBeenCalledTimes(2);

    fireEvent.keyDown(stage, { key: "Enter" });
    expect(onClose).toHaveBeenCalledTimes(3);

    fireEvent.click(
      screen.getByRole("button", { name: "Close image viewer" }),
    );
    expect(onClose).toHaveBeenCalledTimes(4);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(5);
  });
});
