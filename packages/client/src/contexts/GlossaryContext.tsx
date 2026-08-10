import {
  GLOSSARY_TOOLTIPS_CAPABILITY,
  fromUrlProjectId,
  isUrlProjectId,
  serverHasCapability,
} from "@yep-anywhere/shared";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useSyncExternalStore,
} from "react";
import { useGlossaryHints } from "../hooks/useGlossaryHints";
import { useVersion } from "../hooks/useVersion";
import {
  GlossaryArtifactStore,
  type GlossaryArtifactSnapshot,
} from "../lib/glossary/GlossaryArtifactStore";
import { useCurrentSourceRuntime } from "./SourceRuntimeContext";

const INACTIVE_SNAPSHOT: GlossaryArtifactSnapshot = { state: "idle" };
interface GlossaryContextValue {
  projectId: string;
  store: GlossaryArtifactStore;
}

const GlossaryStoreContext = createContext<GlossaryContextValue | null>(null);

function projectRelativeSourcePath(
  projectId: string,
  sourcePath: string | undefined,
): string | undefined {
  if (!sourcePath || !isUrlProjectId(projectId)) return sourcePath;
  const normalizedSource = sourcePath.replaceAll("\\", "/");
  const normalizedRoot = fromUrlProjectId(projectId).replaceAll("\\", "/");
  if (normalizedSource.startsWith(`${normalizedRoot}/`)) {
    return normalizedSource.slice(normalizedRoot.length + 1);
  }
  if (
    normalizedSource.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalizedSource)
  ) {
    // An external file is still session-affiliated prose. It has no meaningful
    // nested project directory, so it receives the root glossary include graph.
    return undefined;
  }
  return sourcePath;
}

export function GlossaryProjectProvider({
  children,
  enabled = true,
  projectId,
}: {
  children: ReactNode;
  enabled?: boolean;
  projectId: string;
}) {
  const enclosing = useContext(GlossaryStoreContext);
  const sourceRuntime = useCurrentSourceRuntime();
  const { glossaryHintsEnabled } = useGlossaryHints();
  const { version } = useVersion();
  const ownedStore = useMemo(() => new GlossaryArtifactStore(), []);
  const enclosingStore =
    enclosing?.projectId === projectId ? enclosing.store : null;
  const ownsStore = enclosingStore === null;
  const ownedStoreActive =
    ownsStore &&
    enabled &&
    glossaryHintsEnabled &&
    isUrlProjectId(projectId) &&
    serverHasCapability(version, GLOSSARY_TOOLTIPS_CAPABILITY);

  useLayoutEffect(() => {
    if (!ownedStoreActive || !isUrlProjectId(projectId)) {
      ownedStore.deactivate();
      return;
    }
    ownedStore.activate(projectId, sourceRuntime.transport);
    return () => ownedStore.deactivate();
  }, [ownedStore, ownedStoreActive, projectId, sourceRuntime.transport]);
  const contextValue = useMemo(
    () =>
      enclosingStore
        ? { projectId, store: enclosingStore }
        : ownedStoreActive
          ? { projectId, store: ownedStore }
          : null,
    [enclosingStore, ownedStore, ownedStoreActive, projectId],
  );

  return (
    <GlossaryStoreContext.Provider value={contextValue}>
      {children}
    </GlossaryStoreContext.Provider>
  );
}

/** Reuse an enclosing project glossary store or create one for this surface. */
export function GlossaryProjectBoundary({
  children,
  projectId,
}: {
  children: ReactNode;
  projectId: string;
}) {
  return (
    <GlossaryProjectProvider projectId={projectId}>
      {children}
    </GlossaryProjectProvider>
  );
}

export function useGlossaryArtifact(
  sourcePath?: string,
): GlossaryArtifactSnapshot {
  const context = useContext(GlossaryStoreContext);
  const resolvedSourcePath = projectRelativeSourcePath(
    context?.projectId ?? "",
    sourcePath,
  );
  const subscribe = useCallback(
    (listener: () => void) =>
      context?.store.subscribe(resolvedSourcePath, listener) ?? (() => {}),
    [context, resolvedSourcePath],
  );
  const getSnapshot = useCallback(
    () => context?.store.getSnapshot(resolvedSourcePath) ?? INACTIVE_SNAPSHOT,
    [context, resolvedSourcePath],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    context?.store.ensure(resolvedSourcePath);
  }, [context, resolvedSourcePath]);

  return snapshot;
}
