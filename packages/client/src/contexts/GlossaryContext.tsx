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
  return normalizedSource.startsWith(`${normalizedRoot}/`)
    ? normalizedSource.slice(normalizedRoot.length + 1)
    : sourcePath;
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
  const sourceRuntime = useCurrentSourceRuntime();
  const { glossaryHintsEnabled } = useGlossaryHints();
  const { version } = useVersion();
  const store = useMemo(() => new GlossaryArtifactStore(), []);
  const active =
    enabled &&
    glossaryHintsEnabled &&
    isUrlProjectId(projectId) &&
    serverHasCapability(version, GLOSSARY_TOOLTIPS_CAPABILITY);

  useLayoutEffect(() => {
    if (!active || !isUrlProjectId(projectId)) {
      store.deactivate();
      return;
    }
    store.activate(projectId, sourceRuntime.transport);
    return () => store.deactivate();
  }, [active, projectId, sourceRuntime.transport, store]);
  const contextValue = useMemo(
    () => (active ? { projectId, store } : null),
    [active, projectId, store],
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
  const context = useContext(GlossaryStoreContext);
  if (context?.projectId === projectId) return children;
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
