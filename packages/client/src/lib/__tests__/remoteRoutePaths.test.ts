import { describe, expect, it } from "vitest";
import {
  getRelayCanonicalRedirectTarget,
  getSafeRemoteReturnTarget,
} from "../remoteRoutePaths";

describe("getRelayCanonicalRedirectTarget", () => {
  it("redirects direct app routes into the active relay namespace", () => {
    expect(
      getRelayCanonicalRedirectTarget(
        {
          pathname: "/projects",
          search: "?queueItem=item-1",
          hash: "#top",
        },
        "macbook",
      ),
    ).toBe("/macbook/projects?queueItem=item-1#top");
  });

  it("redirects bang-command history into the active relay namespace", () => {
    expect(
      getRelayCanonicalRedirectTarget(
        { pathname: "/bang-commands" },
        "macbook",
      ),
    ).toBe("/macbook/bang-commands");
  });

  it("redirects the direct index route to relay projects", () => {
    expect(getRelayCanonicalRedirectTarget({ pathname: "/" }, "macbook")).toBe(
      "/macbook/projects",
    );
  });

  it("does not redirect routes already under the relay namespace", () => {
    expect(
      getRelayCanonicalRedirectTarget(
        { pathname: "/macbook/projects" },
        "macbook",
      ),
    ).toBe(null);
  });

  it("does not redirect when no relay host is active", () => {
    expect(
      getRelayCanonicalRedirectTarget({ pathname: "/projects" }, null),
    ).toBe(null);
  });

  it("does not redirect paths that are not direct app routes", () => {
    expect(
      getRelayCanonicalRedirectTarget(
        { pathname: "/other-host/projects" },
        "macbook",
      ),
    ).toBe(null);
  });
});

describe("getSafeRemoteReturnTarget", () => {
  it("redirects direct return targets into the active relay namespace", () => {
    expect(
      getSafeRemoteReturnTarget("/projects?queueItem=item-1#top", "macbook"),
    ).toBe("/macbook/projects?queueItem=item-1#top");
  });

  it("redirects the direct index return target to relay projects", () => {
    expect(getSafeRemoteReturnTarget("/", "macbook")).toBe("/macbook/projects");
  });

  it("preserves already scoped relay return targets", () => {
    expect(getSafeRemoteReturnTarget("/macbook/projects", "macbook")).toBe(
      "/macbook/projects",
    );
  });

  it("rejects a return target scoped to a different relay host", () => {
    expect(
      getSafeRemoteReturnTarget(
        "/macbook/projects/project-1/sessions/session-1?from=login#turn",
        "laptop",
      ),
    ).toBe(null);
  });

  it("preserves direct return targets when no relay host is active", () => {
    expect(getSafeRemoteReturnTarget("/projects", null)).toBe("/projects");
  });

  it("rejects protocol-relative return targets", () => {
    expect(getSafeRemoteReturnTarget("//example.com/projects", "macbook")).toBe(
      null,
    );
  });

  it("rejects backslash authority return targets", () => {
    expect(getSafeRemoteReturnTarget("/\\evil.example/projects", null)).toBe(
      null,
    );
  });

  it("rejects login return targets", () => {
    expect(
      getSafeRemoteReturnTarget("/login?returnTo=/projects", "macbook"),
    ).toBe(null);
  });
});
