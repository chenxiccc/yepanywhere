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
): Promise<T[]> {
  if (sessions.length === 0) {
    return sessions;
  }

  const readers = new Map<string, ISessionReader | undefined>();
  return Promise.all(
    sessions.map(async (session) => {
      const provider = session.provider ?? project.provider;
      if (!readers.has(provider)) {
        readers.set(
          provider,
          readerForProviderChildren(project, deps, provider, catalog),
        );
      }
      const children = await resolveProviderChildSessions(
        readers.get(provider),
        session.id,
        mode,
      );
      if (!children?.length) {
        return session;
      }
      return { ...session, providerChildren: children };
    }),
  );
}
