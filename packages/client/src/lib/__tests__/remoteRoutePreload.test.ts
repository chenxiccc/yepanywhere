import { describe, expect, it } from "vitest";
import { getInitialRemoteRouteModuleKeys } from "../remoteRoutePreload";

describe("initial remote route preloading", () => {
  it("starts the complete canonical relay session path together", () => {
    expect(
      getInitialRemoteRouteModuleKeys(
        "/-/relay/host/projects/project-1/sessions/session-1",
        "/",
      ),
    ).toEqual([
      "remoteApp",
      "relayConnectionGate",
      "layouts",
      "sessionPage",
      "sessionCore",
    ]);
  });

  it("normalizes a deployed router base before selecting the session", () => {
    expect(
      getInitialRemoteRouteModuleKeys(
        "/remote/-/relay/host/projects/project-1/sessions/session-1",
        "/remote/",
      ),
    ).toContain("sessionCore");
  });

  it("keeps login and public share away from the session graph", () => {
    expect(getInitialRemoteRouteModuleKeys("/login", "/")).toEqual([
      "remoteApp",
      "hostPickerPage",
    ]);
    expect(getInitialRemoteRouteModuleKeys("/share/secret", "/")).toEqual([
      "publicSharePage",
    ]);
    expect(getInitialRemoteRouteModuleKeys("/share/secret/file", "/")).toEqual([
      "publicShareFilePage",
    ]);
  });

  it("selects ordinary authenticated leaf pages with the shared layout", () => {
    expect(
      getInitialRemoteRouteModuleKeys("/settings/appearance", "/"),
    ).toEqual(["remoteApp", "layouts", "settings"]);
    expect(
      getInitialRemoteRouteModuleKeys(
        "/-/relay/host/projects/project-1/file",
        "/",
      ),
    ).toEqual(["remoteApp", "relayConnectionGate", "layouts", "filePage"]);
  });

  it("preloads the legacy redirect without the authenticated page graph", () => {
    expect(
      getInitialRemoteRouteModuleKeys("/old-host/projects/project-1", "/"),
    ).toEqual(["remoteApp", "legacyRelayRouteRedirect"]);
  });
});
