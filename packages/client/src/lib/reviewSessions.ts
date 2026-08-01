import { api, type GlobalSessionItem } from "../api/client";

/** Load every project session in the API's most-recently-active order. */
export async function loadProjectSessions(
  projectId: string,
): Promise<GlobalSessionItem[]> {
  const sessions: GlobalSessionItem[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await api.getGlobalSessions({
      project: projectId,
      limit: 500,
      after,
    });
    sessions.push(...page.sessions);
    if (!page.hasMore) return sessions;
    const nextAfter = page.sessions[page.sessions.length - 1]?.updatedAt;
    if (!nextAfter || nextAfter === after) {
      throw new Error("Existing-session list did not advance");
    }
    after = nextAfter;
  }
}

export function reviewSessionLabel(
  session: GlobalSessionItem,
  suffix?: string,
): string {
  const title = session.customTitle || session.title || session.id.slice(0, 8);
  const runtime = session.model
    ? `${session.provider}/${session.model}`
    : session.provider;
  return suffix ? `${title} · ${runtime} · ${suffix}` : `${title} · ${runtime}`;
}
