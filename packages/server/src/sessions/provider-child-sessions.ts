import type {
  ProviderChildSessionSummary,
  ProviderName,
} from "@yep-anywhere/shared";
import type { Project } from "../supervisor/types.js";
import {
  getSessionSources,
  type ProviderProjectCatalog,
  type ProviderResolutionDeps,
} from "./provider-resolution.js";
import type { ISessionReader } from "./types.js";

export type ProviderChildLookupMode = "fresh" | "accepted-or-cheap";

export async function resolveProviderChildSessions(
  reader:
    | Pick<
        ISessionReader,
        "listProviderChildSessions" | "listAcceptedProviderChildSessions"
      >
    | undefined,
  sessionId: string,
  mode: ProviderChildLookupMode,
): Promise<ProviderChildSessionSummary[] | undefined> {
  if (!reader) {
    return undefined;
  }
  if (
    mode === "accepted-or-cheap" &&
    reader.listAcceptedProviderChildSessions
  ) {
    return reader.listAcceptedProviderChildSessions(sessionId);
  }
  return reader.listProviderChildSessions?.(sessionId);
}

export function readerForProviderChildren(
  project: Project,
  deps: ProviderResolutionDeps,
  provider?: ProviderName,
  catalog?: ProviderProjectCatalog,
): ISessionReader | undefined {
  return getSessionSources(project, deps, provider, catalog)[0]?.reader;
}

export async function attachProviderChildSessions<
  T extends {
    id: string;
    provider?: ProviderName;
    providerChildren?: ProviderChildSessionSummary[];
  },
>(
  sessions: T[],
  project: Project,
  deps: ProviderResolutionDeps,
  mode: ProviderChildLookupMode,
  catalog?: ProviderProjectCatalog,
): Promise<Array<T & { providerChildren?: ProviderChildSessionSummary[] }>> {
  if (sessions.length === 0) {
    return sessions;
  }

  const sessionsByProvider = new Map<
    ProviderName,
    Array<{ index: number; session: T }>
  >();
  sessions.forEach((session, index) => {
    const provider = session.provider ?? project.provider;
    const providerSessions = sessionsByProvider.get(provider);
    if (providerSessions) providerSessions.push({ index, session });
    else sessionsByProvider.set(provider, [{ index, session }]);
  });

  const attached = [...sessions];
  await Promise.all(
    [...sessionsByProvider].map(async ([provider, providerSessions]) => {
      const reader = readerForProviderChildren(
        project,
        deps,
        provider,
        catalog,
      );
      for (const { index, session } of providerSessions) {
        const children = await resolveProviderChildSessions(
          reader,
          session.id,
          mode,
        );
        if (children?.length) {
          attached[index] = { ...session, providerChildren: children };
        }
      }
    }),
  );
  return attached;
}
