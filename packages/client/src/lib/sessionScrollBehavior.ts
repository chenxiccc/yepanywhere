import type { SessionRouteScrollSnapshot } from "./sessionRouteSnapshots";

export const SESSION_SCROLL_BEHAVIOR_MODES = [
  "live-tail",
  "remember-place",
  "no-memory",
] as const;

export type SessionScrollBehaviorMode =
  (typeof SESSION_SCROLL_BEHAVIOR_MODES)[number];

export const DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE: SessionScrollBehaviorMode =
  "live-tail";

export type SessionScrollRestoreDecision =
  | "skip"
  | "follow-bottom"
  | "restore-position";

export function parseSessionScrollBehaviorMode(
  value: string | null | undefined,
): SessionScrollBehaviorMode {
  if (value === "manual-follow") {
    return "remember-place";
  }
  return SESSION_SCROLL_BEHAVIOR_MODES.includes(
    value as SessionScrollBehaviorMode,
  )
    ? (value as SessionScrollBehaviorMode)
    : DEFAULT_SESSION_SCROLL_BEHAVIOR_MODE;
}

export function shouldRetainSessionScrollMemory(
  mode: SessionScrollBehaviorMode,
): boolean {
  return mode !== "no-memory";
}

export function decideSessionScrollRestore({
  mode,
  snapshot,
  topTolerancePx,
}: {
  mode: SessionScrollBehaviorMode;
  snapshot: SessionRouteScrollSnapshot | null | undefined;
  topTolerancePx: number;
}): SessionScrollRestoreDecision {
  if (!snapshot || mode === "no-memory") {
    return "skip";
  }

  if (mode === "live-tail" && (snapshot.following ?? snapshot.atBottom)) {
    return "follow-bottom";
  }

  // A top-of-transcript snapshot is usually produced by a transient
  // cached/progressive restore before tail-follow has settled. Treat it as no
  // useful retained position.
  if (!snapshot.atBottom && snapshot.scrollTop <= topTolerancePx) {
    return "skip";
  }

  if (snapshot.anchor) {
    return "restore-position";
  }

  if (snapshot.atBottom) {
    return "follow-bottom";
  }

  return "restore-position";
}
