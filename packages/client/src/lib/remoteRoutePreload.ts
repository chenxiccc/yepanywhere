import { isDirectAppRouteSegment } from "./remoteRouteSegments";

export type RemoteRouteModuleKey =
  | "activityPage"
  | "agentsPage"
  | "bangCommandsPage"
  | "directLoginPage"
  | "emulatorPage"
  | "filePage"
  | "gitStatusPage"
  | "globalSessionsPage"
  | "hostPickerPage"
  | "hostsPage"
  | "inboxPage"
  | "layouts"
  | "legacyRelayRouteRedirect"
  | "multiHostMonitorPage"
  | "newSessionPage"
  | "projectSessionsRedirect"
  | "projectsPage"
  | "publicShareFilePage"
  | "publicSharePage"
  | "relayConnectionGate"
  | "relayLoginPage"
  | "remoteApp"
  | "sessionCore"
  | "sessionPage"
  | "settings"
  | "workstreamsPage";

function normalizeRouterPathname(pathname: string, baseUrl: string): string {
  const basePath = baseUrl.replace(/\/$/, "");
  if (!basePath || basePath === "/") return pathname || "/";
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`)
    ? pathname.slice(basePath.length)
    : pathname;
}

function selectedAppPageModules(pathname: string): RemoteRouteModuleKey[] {
  if (pathname === "/activity") return ["activityPage"];

  const modules: RemoteRouteModuleKey[] = ["layouts"];
  if (pathname === "/" || pathname === "/projects") {
    return [...modules, "projectsPage"];
  }
  if (/^\/projects\/[^/]+\/sessions\/[^/]+(?:\/|$)/.test(pathname)) {
    return [...modules, "sessionPage", "sessionCore"];
  }
  if (/^\/projects\/[^/]+\/workstreams(?:\/|$)/.test(pathname)) {
    return [...modules, "workstreamsPage"];
  }
  if (/^\/projects\/[^/]+\/file(?:\/|$)/.test(pathname)) {
    return [...modules, "filePage"];
  }
  if (/^\/projects\/[^/]+(?:\/|$)/.test(pathname)) {
    return [...modules, "projectSessionsRedirect"];
  }
  if (pathname === "/sessions") return [...modules, "globalSessionsPage"];
  if (pathname === "/agents") return [...modules, "agentsPage"];
  if (pathname === "/inbox") return [...modules, "inboxPage"];
  if (pathname === "/-/hosts") return [...modules, "hostsPage"];
  if (pathname === "/git-status") return [...modules, "gitStatusPage"];
  if (pathname === "/bang-commands") {
    return [...modules, "bangCommandsPage"];
  }
  if (pathname === "/devices" || pathname.startsWith("/devices/")) {
    return [...modules, "emulatorPage"];
  }
  if (pathname === "/settings" || pathname.startsWith("/settings/")) {
    return [...modules, "settings"];
  }
  if (pathname === "/new-session") return [...modules, "newSessionPage"];
  return [...modules, "projectsPage"];
}

export function getInitialRemoteRouteModuleKeys(
  browserPathname: string,
  baseUrl: string,
): RemoteRouteModuleKey[] {
  const pathname = normalizeRouterPathname(browserPathname, baseUrl);

  if (/^\/(?:remote\/)?share\/[^/]+\/file(?:\/|$)/.test(pathname)) {
    return ["publicShareFilePage"];
  }
  if (/^\/(?:remote\/)?share\/[^/]+(?:\/|$)/.test(pathname)) {
    return ["publicSharePage"];
  }
  if (pathname === "/-/monitor") return ["multiHostMonitorPage"];

  if (pathname === "/login" || pathname === "/login/") {
    return ["remoteApp", "hostPickerPage"];
  }
  if (pathname === "/login/direct") {
    return ["remoteApp", "directLoginPage"];
  }
  if (pathname === "/login/relay") {
    return ["remoteApp", "relayLoginPage"];
  }

  const relayMatch = pathname.match(/^\/-\/relay\/[^/]+(\/.*)?$/);
  if (relayMatch) {
    const appPathname = relayMatch[1] || "/";
    return [
      "remoteApp",
      "relayConnectionGate",
      ...selectedAppPageModules(appPathname),
    ];
  }

  const firstSegment = pathname.split("/")[1];
  if (
    pathname === "/" ||
    pathname === "/-/hosts" ||
    (firstSegment && isDirectAppRouteSegment(firstSegment))
  ) {
    return ["remoteApp", ...selectedAppPageModules(pathname)];
  }

  return ["remoteApp", "legacyRelayRouteRedirect"];
}
