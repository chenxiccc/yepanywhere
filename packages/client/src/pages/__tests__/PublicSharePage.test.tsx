// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import {
  type AppSession,
  type PublicSessionSharePublicMetadata,
  type PublicSessionShareResponse,
  toUrlProjectId,
} from "@yep-anywhere/shared";
import { Link, MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildPublicShareRawFileApiPath,
  rewritePublicShareLocalAppHref,
  rewritePublicShareLocalAppLinks,
} from "../../contexts/PublicShareContext";
import { I18nProvider } from "../../i18n";
import {
  fetchPublicShareV2ViaRelay,
  fetchPublicShareViaRelay,
} from "../../lib/publicShareRelay";
import {
  getPublicShareCautionKey,
  isPublicShareLocalAppHref,
  PublicSharePage,
} from "../PublicSharePage";

vi.mock("../../lib/publicShareRelay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/publicShareRelay")>()),
  fetchPublicShareV2ViaRelay: vi.fn(),
  fetchPublicShareViaRelay: vi.fn(),
}));

const fetchPublicShareV2ViaRelayMock = vi.mocked(fetchPublicShareV2ViaRelay);
const fetchPublicShareViaRelayMock = vi.mocked(fetchPublicShareViaRelay);

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const pageProjectId = toUrlProjectId("/repo");

function publicShareResult(
  title: string,
  options: { messageId?: string; mode?: "frozen" | "live" } = {},
): {
  metadata: PublicSessionSharePublicMetadata;
  share: PublicSessionShareResponse;
} {
  const mode = options.mode ?? "frozen";
  const messages: AppSession["messages"] = options.messageId
    ? [
        {
          type: "user",
          isSidechain: false,
          userType: "external",
          cwd: "/repo",
          sessionId: "session-1",
          version: "2.1.0",
          uuid: options.messageId,
          parentUuid: null,
          message: { role: "user", content: `${title} transcript row` },
          timestamp: "2026-08-06T00:00:00.000Z",
        },
      ]
    : [];
  const session: AppSession = {
    id: "session-1",
    projectId: pageProjectId,
    projectName: "repo",
    title,
    fullTitle: title,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:01:00.000Z",
    messageCount: messages.length,
    ownership: { owner: "none" },
    provider: "claude",
    messages,
  };
  const metadata: PublicSessionSharePublicMetadata = {
    mode,
    title,
    initialPrompt: null,
    projectName: "repo",
    provider: "claude",
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    capturedAt: session.updatedAt,
    linkedFileMode: "cow",
  };
  return {
    metadata,
    share: {
      share: {
        mode,
        title,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        capturedAt: session.updatedAt,
        linkedFileMode: "cow",
        source: {
          projectId: pageProjectId,
          sessionId: session.id,
          projectName: "repo",
          provider: "claude",
        },
      },
      session,
    },
  };
}

describe("isPublicShareLocalAppHref", () => {
  const shareUrl = "https://ya.graehl.org/share/secret";

  it("blocks authenticated local file routes inside public shares", () => {
    expect(
      isPublicShareLocalAppHref(
        "/projects/project-1/file?path=README.md",
        shareUrl,
      ),
    ).toBe(true);
    expect(
      isPublicShareLocalAppHref(
        "/api/local-file?path=%2Frepo%2FREADME.md",
        shareUrl,
      ),
    ).toBe(true);
    expect(
      isPublicShareLocalAppHref(
        "/api/local-image?path=%2Frepo%2Fplot.png",
        shareUrl,
      ),
    ).toBe(true);
  });

  it("leaves external and public share links alone", () => {
    expect(
      isPublicShareLocalAppHref("https://example.com/README.md", shareUrl),
    ).toBe(false);
    expect(isPublicShareLocalAppHref("/share/other", shareUrl)).toBe(false);
  });
});

describe("getPublicShareCautionKey", () => {
  it("uses the stronger secret warning for live shares", () => {
    expect(getPublicShareCautionKey("live")).toBe(
      "publicShareLiveSecretWarning",
    );
  });

  it("uses the milder public-output caution for snapshots", () => {
    expect(getPublicShareCautionKey("frozen")).toBe(
      "publicShareReadOnlySecretCaution",
    );
  });
});

describe("PublicSharePage", () => {
  it("aborts stale v2 work and keeps the replacement share published", async () => {
    window.history.replaceState(null, "", "/share/secret-one?h=host-one#v=2");
    const releaseResources = vi.fn();
    let firstSignal: AbortSignal | undefined;
    let publishFirstMetadata:
      | ((metadata: PublicSessionSharePublicMetadata) => void)
      | undefined;
    let resolveFirst!: (value: ReturnType<typeof publicShareResult>) => void;
    const firstResult = new Promise<ReturnType<typeof publicShareResult>>(
      (resolve) => {
        resolveFirst = resolve;
      },
    );
    fetchPublicShareV2ViaRelayMock
      .mockImplementationOnce((options) => {
        firstSignal = options.signal;
        publishFirstMetadata = options.onMetadata;
        options.signal?.addEventListener("abort", releaseResources, {
          once: true,
        });
        return firstResult;
      })
      .mockResolvedValueOnce(publicShareResult("Second share"));

    render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/share/secret-one?h=host-one#v=2"]}>
          <Link to="/share/secret-two?h=host-one#v=2">Next share</Link>
          <Routes>
            <Route path="/share/:secret" element={<PublicSharePage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );
    await waitFor(() => {
      expect(fetchPublicShareV2ViaRelayMock).toHaveBeenCalledTimes(1);
    });

    fireEvent.click(screen.getByRole("link", { name: "Next share" }));
    expect(
      await screen.findByRole("heading", { name: "Second share" }),
    ).toBeTruthy();
    expect(firstSignal?.aborted).toBe(true);
    expect(releaseResources).toHaveBeenCalledTimes(1);

    act(() => {
      publishFirstMetadata?.(publicShareResult("Stale metadata").metadata);
    });
    expect(
      screen.queryByRole("heading", { name: "Stale metadata" }),
    ).toBeNull();

    await act(async () => {
      resolveFirst(publicShareResult("Stale first share"));
      await firstResult;
    });
    expect(screen.getByRole("heading", { name: "Second share" })).toBeTruthy();
    expect(
      screen.queryByRole("heading", { name: "Stale first share" }),
    ).toBeNull();
    expect(fetchPublicShareViaRelayMock).not.toHaveBeenCalled();
  });

  it("starts a fresh bootstrap when every share identity coordinate changes", async () => {
    const first = publicShareResult("First share", {
      mode: "live",
      messageId: "first-message-id",
    });
    const second = publicShareResult("Second share", {
      messageId: "second-message-id",
    });
    let resolveSecond!: (value: typeof second) => void;
    const secondResult = new Promise<typeof second>((resolve) => {
      resolveSecond = resolve;
    });
    fetchPublicShareV2ViaRelayMock
      .mockImplementationOnce(async (options) => {
        options.onMetadata?.(first.metadata);
        return first;
      })
      .mockImplementationOnce((options) => {
        options.onMetadata?.(second.metadata);
        return secondResult;
      });

    render(
      <I18nProvider>
        <MemoryRouter
          initialEntries={[
            "/share/secret-one?h=host-one&r=wss%3A%2F%2Frelay.one%2Fws&viewerId=viewer-one#v=2&t=First%20hint",
          ]}
        >
          <Link to="/share/secret-two?h=host-two&r=wss%3A%2F%2Frelay.two%2Fws&viewerId=viewer-two#v=2&t=Second%20hint">
            Next identity
          </Link>
          <Routes>
            <Route path="/share/:secret" element={<PublicSharePage />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>,
    );

    expect(await screen.findByText("First share transcript row")).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Next identity" }));

    await waitFor(() => {
      expect(fetchPublicShareV2ViaRelayMock).toHaveBeenCalledTimes(2);
    });
    expect(fetchPublicShareV2ViaRelayMock.mock.calls[1]?.[0]).toMatchObject({
      relayUrl: "wss://relay.two/ws",
      relayUsername: "host-two",
      secret: "secret-two",
      viewerId: "viewer-two",
    });
    expect(fetchPublicShareViaRelayMock).not.toHaveBeenCalled();
    expect(screen.queryByText("First share transcript row")).toBeNull();
    expect(screen.getByRole("heading", { name: "Second share" })).toBeTruthy();

    await act(async () => {
      resolveSecond(second);
      await secondResult;
    });
    expect(await screen.findByText("Second share transcript row")).toBeTruthy();
    expect(screen.queryByText("First share transcript row")).toBeNull();
  });
});

describe("rewritePublicShareLocalAppHref", () => {
  const projectId = toUrlProjectId("/local/graehl/yepanywhere");
  const context = {
    projectId,
    relayUrl: "wss://relay.graehl.org/ws",
    relayUsername: "ygraehl",
    secret: "share-secret",
  };
  const shareUrl = "https://ya.graehl.org/share/share-secret?h=ygraehl";

  it("rewrites project file viewer links to public share file routes", () => {
    const rewritten = rewritePublicShareLocalAppHref(
      `/projects/${projectId}/file?path=ui-report%2FREADME.md&line=8&view=range`,
      context,
      shareUrl,
    );

    expect(rewritten).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}&line=8&view=range`,
    );
  });

  it("strips private project-file inline-code links from public shares", () => {
    const root = document.createElement("div");
    root.innerHTML = `<p>See <a class="fixed-font-file-link" data-ya-private-project-file-link="true" data-ya-resource="project-file" data-ya-project-id="${projectId}" data-ya-path="topics/security.md" href="/projects/${projectId}/file?path=topics%2Fsecurity.md"><code>topics/security.md</code></a>.</p>`;

    rewritePublicShareLocalAppLinks(root, context, shareUrl);

    expect(root.querySelector("a")).toBeNull();
    expect(root.querySelector("code")?.textContent).toBe("topics/security.md");
    expect(root.innerHTML).not.toContain("/projects/");
    expect(root.innerHTML).not.toContain("data-ya-private-project-file-link");
  });

  it("rewrites local-file links under the shared project root", () => {
    const rewritten = rewritePublicShareLocalAppHref(
      "https://ya.graehl.org/api/local-file?path=%2Flocal%2Fgraehl%2Fyepanywhere%2Fui-report%2FREADME.md&render=1&line=8&lineEnd=12",
      context,
      shareUrl,
    );

    expect(rewritten).toBe(
      `/share/share-secret/file?path=ui-report%2FREADME.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${projectId}&line=8&lineEnd=12`,
    );
  });

  it("rewrites Windows local-file links under the shared project root", () => {
    const windowsProjectRoot = "C:\\Users\\user\\Documents\\code\\playbox";
    const windowsProjectId = toUrlProjectId(windowsProjectRoot);
    const windowsContext = {
      ...context,
      projectId: windowsProjectId,
    };
    const rewritten = rewritePublicShareLocalAppHref(
      "https://ya.graehl.org/api/local-file?path=C%3A%5CUsers%5Cuser%5CDocuments%5Ccode%5Cplaybox%5Cdocs%5Cguide.md&render=1",
      windowsContext,
      shareUrl,
    );

    expect(rewritten).toBe(
      `/share/share-secret/file?path=docs%2Fguide.md&h=ygraehl&r=wss%3A%2F%2Frelay.graehl.org%2Fws&projectId=${windowsProjectId}`,
    );
  });

  it("marks local image sources for public share media hydration", () => {
    const root = document.createElement("div");
    root.innerHTML =
      '<img src="/api/local-image?path=%2Flocal%2Fgraehl%2Fyepanywhere%2Fui-report%2Fplot.png">';

    rewritePublicShareLocalAppLinks(root, context, shareUrl);

    expect(
      root.querySelector("img")?.getAttribute("data-public-share-src-path"),
    ).toBe("ui-report/plot.png");
  });

  it("builds share-scoped raw file API paths", () => {
    expect(
      buildPublicShareRawFileApiPath(
        context,
        "/local/graehl/yepanywhere/ui-report/plot.png",
      ),
    ).toBe(
      "/public-api/shares/share-secret/files/raw?path=ui-report%2Fplot.png",
    );
  });

  it("keeps viewer-specific freezes on rewritten file requests", () => {
    const viewerContext = { ...context, viewerId: "viewer-token-1" };
    expect(
      rewritePublicShareLocalAppHref(
        `/projects/${projectId}/file?path=topics%2Fsecurity.md`,
        viewerContext,
        shareUrl,
      ),
    ).toContain("viewerId=viewer-token-1");
    expect(
      buildPublicShareRawFileApiPath(viewerContext, "topics/security.md"),
    ).toContain("viewerId=viewer-token-1");
  });
});
