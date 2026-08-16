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
