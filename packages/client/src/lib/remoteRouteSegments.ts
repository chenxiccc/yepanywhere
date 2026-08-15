const DIRECT_APP_ROUTE_SEGMENTS = new Set([
  "activity",
  "agents",
  "bang-commands",
  "devices",
  "git-status",
  "inbox",
  "new-session",
  "projects",
  "sessions",
  "settings",
]);

const RESERVED_REMOTE_ROUTE_SEGMENTS = new Set([
  ...DIRECT_APP_ROUTE_SEGMENTS,
  "-",
  "login",
  "remote",
  "share",
]);

export function isDirectAppRouteSegment(segment: string): boolean {
  return DIRECT_APP_ROUTE_SEGMENTS.has(segment);
}

export function isReservedRemoteRouteSegment(segment: string): boolean {
  return RESERVED_REMOTE_ROUTE_SEGMENTS.has(segment);
}
