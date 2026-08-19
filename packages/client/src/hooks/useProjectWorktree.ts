import type { GitWorktreeCoverage } from "@yep-anywhere/shared";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useCurrentSourceRuntime } from "../contexts/SourceRuntimeContext";
import {
  getProjectWorktreeStore,
  type ProjectWorktreeSnapshot,
} from "../lib/projectWorktreeStore";

const DISABLED_SNAPSHOT: ProjectWorktreeSnapshot = {
  loading: false,
  error: null,
  generation: null,
  headSha: null,
  baseSha: null,
  files: [],
  truncated: false,
};

export const ProjectWorktreePauseContext = createContext(false);

export function useProjectWorktree(
  projectId: string,
  coverage: GitWorktreeCoverage,
  enabled: boolean,
  pausedOverride?: boolean,
  deferUpdates = false,
  maxDeferralMs = 5_000,
): ProjectWorktreeSnapshot {
  const runtime = useCurrentSourceRuntime();
  const pausedByContext = useContext(ProjectWorktreePauseContext);
  const paused = pausedOverride ?? pausedByContext;
  const store = useMemo(
    () =>
      enabled
        ? getProjectWorktreeStore(
            runtime.sourceKey,
            projectId,
            runtime.transport,
          )
        : null,
    [enabled, projectId, runtime.sourceKey, runtime.transport],
  );

  const { ignored, tracked, untracked } = coverage;
  useEffect(() => {
    if (!store) return;
    return store.retain({ ignored, tracked, untracked });
  }, [ignored, store, tracked, untracked]);

  const current = useSyncExternalStore(
    store?.subscribe ?? emptySubscribe,
    store?.getSnapshot ?? getDisabledSnapshot,
    getDisabledSnapshot,
  );
  const visible = useRef({ store, snapshot: current });
  const wasPaused = useRef(paused);
  const deferralDeadline = useRef<number | null>(null);
  const forceDeferredUpdate = useRef(false);
  const [, rerenderAfterDeadline] = useState(0);
  const resumed = wasPaused.current && !paused;
  wasPaused.current = paused;
  if (
    visible.current.store !== store ||
    (!paused && (!deferUpdates || resumed || forceDeferredUpdate.current)) ||
    visible.current.snapshot.generation === null
  ) {
    visible.current = { store, snapshot: current };
    forceDeferredUpdate.current = false;
    deferralDeadline.current = null;
  }
  const updateDeferred =
    !paused && deferUpdates && visible.current.snapshot !== current;
  useEffect(() => {
    if (!updateDeferred) {
      deferralDeadline.current = null;
      return;
    }
    const now = Date.now();
    deferralDeadline.current ??= now + maxDeferralMs;
    const timer = setTimeout(
      () => {
        forceDeferredUpdate.current = true;
        deferralDeadline.current = null;
        rerenderAfterDeadline((value) => value + 1);
      },
      Math.max(0, deferralDeadline.current - now),
    );
    return () => clearTimeout(timer);
  }, [maxDeferralMs, updateDeferred]);
  return visible.current.snapshot;
}

function emptySubscribe(): () => void {
  return () => {};
}

function getDisabledSnapshot(): ProjectWorktreeSnapshot {
  return DISABLED_SNAPSHOT;
}
