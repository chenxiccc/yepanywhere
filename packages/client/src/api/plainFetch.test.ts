import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchPlainBlob, fetchPlainJSON } from "./plainFetch";

describe("fetchPlainJSON", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends desktop token and same-origin headers", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await fetchPlainJSON("/projects", undefined, {
      desktopAuthToken: "desktop-secret",
      fetchImpl,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/projects");
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-yep-anywhere")).toBe("true");
    expect(headers.get("x-yep-client-version")).toBe("unknown");
    expect(headers.get("x-desktop-token")).toBe("desktop-secret");
  });

  it("signals login-required and preserves setup-required on 401 responses", async () => {
    const onLoginRequired = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ error: "login required" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: {
          "content-type": "application/json",
          "X-Setup-Required": "true",
        },
      }),
    );

    await expect(
      fetchPlainJSON("/sessions", undefined, {
        fetchImpl,
        onLoginRequired,
      }),
    ).rejects.toMatchObject({
      message: "login required",
      status: 401,
      setupRequired: true,
    });
    expect(onLoginRequired).toHaveBeenCalledTimes(1);
  });

  it("does not signal login-required for auth endpoints", async () => {
    const onLoginRequired = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(JSON.stringify({ message: "bad password" }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      fetchPlainJSON("/auth/login", undefined, {
        fetchImpl,
        onLoginRequired,
      }),
    ).rejects.toMatchObject({
      message: "bad password",
      status: 401,
    });
    expect(onLoginRequired).not.toHaveBeenCalled();
  });

  it("passes blob cache directives and caller headers to fetch", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("png-bytes"));

    await fetchPlainBlob(
      "/local-image?path=%2Ftmp%2Fplot.png",
      {
        cache: "no-cache",
        headers: { "X-File-Probe": "current" },
      },
      { fetchImpl },
    );

    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("/api/local-image?path=%2Ftmp%2Fplot.png");
    expect(init?.cache).toBe("no-cache");
    expect(init?.credentials).toBe("include");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-file-probe")).toBe("current");
    expect(headers.get("x-yep-anywhere")).toBe("true");
  });
});
