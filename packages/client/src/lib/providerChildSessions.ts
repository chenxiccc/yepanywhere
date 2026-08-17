import type { ProviderChildSessionSummary } from "@yep-anywhere/shared";

const RECENTLY_ACTIVE_MS = 3 * 60 * 1000;

export function providerChildSessionHref(
  basePath: string,
  projectId: string,
  sessionId: string,
  agentId: string,
): string {
  const root = basePath.replace(/\/$/, "");
  return `${root}/projects/${projectId}/sessions/${sessionId}/agents/${encodeURIComponent(agentId)}`;
}

export function providerChildTitle(
  child: Pick<ProviderChildSessionSummary, "title" | "agentType">,
  fallback: string,
): string {
  return child.title || child.agentType || fallback;
}

export function firstDefinedProviderChildren(
  ...sources: Array<ProviderChildSessionSummary[] | undefined>
): ProviderChildSessionSummary[] {
  for (const source of sources) {
    if (source) {
      return source;
    }
  }
  return [];
}

export function latestProviderChildUpdatedAt(
  children: readonly ProviderChildSessionSummary[],
): string | undefined {
  let latest: string | undefined;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const child of children) {
    const ms = Date.parse(child.updatedAt);
    if (!Number.isNaN(ms) && ms > latestMs) {
      latestMs = ms;
      latest = child.updatedAt;
    }
  }
  return latest;
}

/** How prominent a subagent's activity marker is among its siblings. */
export type ProviderChildActivityLevel = "latest" | "recent" | "older";

/** Sibling lag that still counts as "was working around the same time". */
const RECENT_BEHIND_LATEST_MS = 5 * 60 * 1000;

/**
 * Rank sibling subagents by how recently each transcript changed, measured
 * against the freshest sibling rather than the wall clock.
 *
 * A relative scale is what the sidebar marker needs: it answers "which of
 * these ran last", and it only changes when the summaries themselves change.
 * An absolute age would need a per-minute clock and would repaint every
 * expanded outline on every tick for no added meaning.
 */
export function providerChildActivityLevels(
  children: readonly ProviderChildSessionSummary[],
): Map<string, ProviderChildActivityLevel> {
  const levels = new Map<string, ProviderChildActivityLevel>();
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const child of children) {
    const ms = Date.parse(child.updatedAt);
    if (Number.isFinite(ms) && ms > latestMs) {
      latestMs = ms;
    }
  }
  for (const child of children) {
    const ms = Date.parse(child.updatedAt);
    if (!Number.isFinite(ms) || latestMs === Number.NEGATIVE_INFINITY) {
      levels.set(child.id, "older");
      continue;
    }
    const behindMs = latestMs - ms;
    levels.set(
      child.id,
      behindMs === 0
        ? "latest"
        : behindMs < RECENT_BEHIND_LATEST_MS
          ? "recent"
          : "older",
    );
  }
  return levels;
}

export function countRecentlyActiveProviderChildren(
  children: readonly ProviderChildSessionSummary[],
  processState: string | null | undefined,
  nowMs = Date.now(),
): number {
  if (processState !== "in-turn") {
    return 0;
  }
  return children.filter((child) => {
    const ms = Date.parse(child.updatedAt);
    return !Number.isNaN(ms) && nowMs - ms < RECENTLY_ACTIVE_MS;
  }).length;
}
